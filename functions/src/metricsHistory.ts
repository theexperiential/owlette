/**
 * Metrics History Cloud Function
 *
 * Triggered on every metrics write to populate the metrics_history subcollection.
 * This approach uses the single metrics write from the agent to populate history,
 * avoiding duplicate writes from the agent.
 *
 * Also evaluates threshold alert rules and triggers notifications when breached.
 *
 * Data flow:
 * 1. Agent writes to: sites/{siteId}/machines/{machineId} (metrics data)
 * 2. This function triggers and writes to: sites/{siteId}/machines/{machineId}/metrics_history/{date}
 * 3. Evaluates threshold alert rules from sites/{siteId}/settings/alerts
 * 4. If threshold breached + not in cooldown, calls /api/alerts/trigger
 *
 * Rate limiting:
 * - Checks last sample timestamp to avoid duplicate samples within 55 seconds
 * - Uses Firestore FieldValue.arrayUnion for atomic append (no read-modify-write)
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import https = require('https');
import http = require('http');

// Get Firestore instance
const db = admin.firestore();

/* ------------------------------------------------------------------ */
/*  Threshold Alert Types & Cache                                      */
/* ------------------------------------------------------------------ */

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: string;
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

interface CachedAlertRules {
  rules: AlertRule[];
  fetchedAt: number;
}

/** Module-level cache: siteId → cached rules (5-minute TTL) */
const alertRulesCache = new Map<string, CachedAlertRules>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Metric name → path into the metrics object from the machine document */
const METRIC_PATHS: Record<string, (m: Record<string, any>) => number | undefined> = {
  cpu_percent:        (m) => m.cpu?.percent,
  memory_percent:     (m) => m.memory?.percent,
  disk_percent:       (m) => m.disk?.percent,
  gpu_percent:        (m) => m.gpu?.usage_percent,
  cpu_temp:           (m) => m.cpu?.temperature,
  gpu_temp:           (m) => m.gpu?.temperature,
  network_latency:    (m) => m.network?.latency_ms,
  network_packet_loss:(m) => m.network?.packet_loss_pct,
};

/**
 * Historical metrics sample with abbreviated keys for storage efficiency
 */
interface NicSample {
  i: string;   // interface name
  tx: number;  // TX bytes/sec
  rx: number;  // RX bytes/sec
  tu: number;  // TX utilization % of link speed
  ru: number;  // RX utilization % of link speed
}

interface MetricsSample {
  t: number;   // timestamp (unix seconds)
  c: number;   // cpu percent
  m: number;   // memory percent
  d: number;   // disk percent
  g?: number;  // gpu percent (optional)
  ct?: number; // cpu temperature (optional)
  gt?: number; // gpu temperature (optional)
  n?: NicSample[]; // per-NIC network metrics (optional)
  nl?: number; // network latency ms (gateway ping, optional)
  np?: number; // network packet loss % (gateway ping, optional)
}

/**
 * Triggered when a machine document is written (created or updated).
 * Extracts metrics and appends to the daily history bucket.
 */
export const onMetricsWrite = onDocumentWritten(
  'sites/{siteId}/machines/{machineId}',
  async (event) => {
    const { siteId, machineId } = event.params;

    // Get the after data (new state)
    const afterData = event.data?.after?.data();
    if (!afterData) {
      console.log(`No data after write for ${machineId}, skipping`);
      return;
    }

    // Check if this write contains metrics
    const metrics = afterData.metrics;
    if (!metrics) {
      console.log(`No metrics in write for ${machineId}, skipping`);
      return;
    }

    // Get current timestamp
    const now = Math.floor(Date.now() / 1000);

    // Get today's date in UTC for bucket ID
    const today = new Date();
    const bucketId = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // Path to history document
    const historyRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('metrics_history')
      .doc(bucketId);

    // Check if we should rate limit (avoid duplicate samples within 55 seconds)
    try {
      const historyDoc = await historyRef.get();
      if (historyDoc.exists) {
        const meta = historyDoc.data()?.meta;
        if (meta?.lastSampleTime) {
          const lastSampleTime = meta.lastSampleTime;
          if (now - lastSampleTime < 55) {
            // Too soon since last sample, skip
            console.log(`Rate limiting: last sample was ${now - lastSampleTime}s ago for ${machineId}`);
            return;
          }
        }
      }
    } catch (err) {
      // If we can't check, proceed anyway
      console.warn(`Could not check rate limit for ${machineId}:`, err);
    }

    // Build compact sample object
    const sample: MetricsSample = {
      t: now,
      c: round(metrics.cpu?.percent ?? 0),
      m: round(metrics.memory?.percent ?? 0),
      d: round(metrics.disk?.percent ?? 0),
    };

    // Add optional GPU percent
    if (metrics.gpu?.usage_percent !== undefined && metrics.gpu.usage_percent !== null) {
      sample.g = round(metrics.gpu.usage_percent);
    }

    // Add optional temperatures
    if (metrics.cpu?.temperature !== undefined && metrics.cpu.temperature !== null) {
      sample.ct = round(metrics.cpu.temperature);
    }
    if (metrics.gpu?.temperature !== undefined && metrics.gpu.temperature !== null) {
      sample.gt = round(metrics.gpu.temperature);
    }

    // Add network quality (gateway ping)
    if (metrics.network?.latency_ms !== undefined && metrics.network.latency_ms !== null) {
      sample.nl = round(metrics.network.latency_ms);
    }
    if (metrics.network?.packet_loss_pct !== undefined && metrics.network.packet_loss_pct !== null) {
      sample.np = round(metrics.network.packet_loss_pct);
    }

    // Add per-NIC network metrics
    const interfaces = metrics.network?.interfaces;
    if (interfaces && typeof interfaces === 'object') {
      const nicEntries: NicSample[] = [];
      for (const [name, data] of Object.entries(interfaces)) {
        const nic = data as Record<string, number>;
        if ((nic.tx_bps ?? 0) > 0 || (nic.rx_bps ?? 0) > 0) {
          nicEntries.push({
            i: name,
            tx: Math.round(nic.tx_bps ?? 0),
            rx: Math.round(nic.rx_bps ?? 0),
            tu: round(nic.tx_util ?? 0),
            ru: round(nic.rx_util ?? 0),
          });
        }
      }
      if (nicEntries.length > 0) {
        sample.n = nicEntries;
      }
    }

    // Use arrayUnion for atomic append without read-modify-write
    try {
      await historyRef.set(
        {
          samples: FieldValue.arrayUnion(sample),
          meta: {
            lastSampleTime: now,
            updatedAt: FieldValue.serverTimestamp(),
            resolution: '1min',
          },
        },
        { merge: true }
      );

      console.log(`Historical sample recorded for ${machineId} in bucket ${bucketId}`);
    } catch (err) {
      console.error(`Failed to write historical sample for ${machineId}:`, err);
      throw err; // Re-throw to mark function as failed
    }

    // Evaluate threshold alert rules (non-blocking — don't fail the function)
    try {
      await evaluateThresholdAlerts(siteId, machineId, metrics);
    } catch (err) {
      console.error(`Threshold alert evaluation failed for ${machineId}:`, err);
    }
  }
);

/**
 * Round a number to 1 decimal place
 */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------ */
/*  Threshold Alert Evaluation                                         */
/* ------------------------------------------------------------------ */

/**
 * Fetch alert rules for a site, using a 5-minute in-memory cache.
 */
async function getAlertRules(siteId: string): Promise<AlertRule[]> {
  const cached = alertRulesCache.get(siteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rules;
  }

  const alertsDoc = await db.doc(`sites/${siteId}/settings/alerts`).get();
  const rules: AlertRule[] = [];

  if (alertsDoc.exists) {
    const data = alertsDoc.data();
    if (Array.isArray(data?.rules)) {
      for (const r of data.rules) {
        if (r && typeof r.id === 'string' && typeof r.metric === 'string') {
          rules.push(r as AlertRule);
        }
      }
    }
  }

  alertRulesCache.set(siteId, { rules, fetchedAt: Date.now() });
  return rules;
}

/**
 * Evaluate whether a metric value breaches a threshold.
 */
function isBreached(metricValue: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':  return metricValue > threshold;
    case '<':  return metricValue < threshold;
    case '>=': return metricValue >= threshold;
    case '<=': return metricValue <= threshold;
    default:   return false;
  }
}

/**
 * Evaluate all threshold alert rules for the given metrics write.
 * For each breached rule not in cooldown, triggers a notification via the web API.
 */
async function evaluateThresholdAlerts(
  siteId: string,
  machineId: string,
  metrics: Record<string, any>
): Promise<void> {
  const rules = await getAlertRules(siteId);
  if (rules.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Extract metric value
    const extractor = METRIC_PATHS[rule.metric];
    if (!extractor) continue;

    const metricValue = extractor(metrics);
    if (metricValue === undefined || metricValue === null) continue;

    // Check threshold
    if (!isBreached(metricValue, rule.operator, rule.value)) continue;

    // Check cooldown
    const cooldownRef = db.doc(
      `sites/${siteId}/alert_cooldowns/${rule.id}_${machineId}`
    );

    try {
      const cooldownDoc = await cooldownRef.get();
      if (cooldownDoc.exists) {
        const lastTriggered = cooldownDoc.data()?.lastTriggered as number;
        if (lastTriggered && now - lastTriggered < rule.cooldownMinutes * 60) {
          continue; // Still in cooldown
        }
      }
    } catch (err) {
      console.warn(`Could not check cooldown for rule ${rule.id}:`, err);
    }

    // Write cooldown timestamp
    try {
      await cooldownRef.set({ lastTriggered: now });
    } catch (err) {
      console.warn(`Could not write cooldown for rule ${rule.id}:`, err);
    }

    // Trigger alert via web API
    try {
      await callAlertTriggerApi({
        siteId,
        machineId,
        ruleName: rule.name,
        metric: rule.metric,
        value: metricValue,
        threshold: rule.value,
        operator: rule.operator,
        severity: rule.severity,
        channels: rule.channels,
      });
      console.log(
        `Threshold alert triggered: ${rule.name} — ${rule.metric} ${metricValue} ${rule.operator} ${rule.value} on ${machineId}`
      );
    } catch (err) {
      console.error(`Failed to trigger alert for rule ${rule.id}:`, err);
    }
  }
}

/**
 * Derive the web API base URL from the Firebase project ID.
 * This avoids needing separate env vars for dev vs prod.
 */
function getApiBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
  if (projectId.includes('dev')) return 'https://dev.owlette.app';
  return 'https://owlette.app';
}

/**
 * POST to the /api/alerts/trigger endpoint on the web server.
 * Uses the built-in Node.js http/https modules (no external deps).
 */
function callAlertTriggerApi(body: Record<string, unknown>): Promise<void> {
  const baseUrl = process.env.API_BASE_URL || getApiBaseUrl();
  const secret = process.env.CORTEX_INTERNAL_SECRET;

  if (!secret) {
    console.warn('CORTEX_INTERNAL_SECRET not configured — skipping alert trigger');
    return Promise.resolve();
  }

  const url = new URL('/api/alerts/trigger', baseUrl);
  const payload = JSON.stringify(body);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<void>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-internal-secret': secret,
        },
        timeout: 10_000,
      },
      (res) => {
        // Consume the response body to free resources
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Alert trigger API returned status ${res.statusCode}`));
        }
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Alert trigger API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}
