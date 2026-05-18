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
 * 2. This function triggers and writes to: sites/{siteId}/machines/{machineId}/metrics_history/{bucket}
 * 3. Evaluates threshold alert rules from sites/{siteId}/settings/alerts
 * 4. If threshold breached + not in cooldown, calls /api/alerts/trigger
 *
 * Rate limiting:
 * - Checks last sample timestamp to avoid duplicate samples within 55 seconds
 * - Uses Firestore FieldValue.arrayUnion for atomic append (no read-modify-write)
 *
 * History bucket schema:
 * - Legacy docs used one daily bucket: metrics_history/{YYYY-MM-DD}
 * - New writes use hourly UTC buckets: metrics_history/{YYYY-MM-DD-HH}
 *
 * The samples/meta shape is unchanged. Splitting the daily array into 24 hourly
 * docs keeps rich 30-second telemetry well below Firestore's 1MiB document
 * limit while leaving existing daily docs available for readers that support
 * both shapes.
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

/**
 * Resolve scalar fields from either v2 (schemaVersion 2, per-device maps keyed
 * by id + metrics.primary) or v1 (singular cpu/disk/gpu objects) metrics docs.
 * The helpers below pick the primary device for aggregates (sparkline/alerts),
 * falling back to the first entry when `primary` is absent, and finally to the
 * legacy v1 fields so in-flight docs during rollout still produce samples.
 */
function pickPrimaryEntry<T>(
  map: Record<string, T> | undefined,
  primaryId: string | null | undefined,
): T | undefined {
  if (!map) return undefined;
  if (primaryId && map[primaryId]) return map[primaryId];
  const first = Object.values(map)[0];
  return first;
}

function v2CpuPercent(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.cpus, m.primary?.cpu)?.percent ?? m.cpu?.percent;
}
function v2CpuTemp(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.cpus, m.primary?.cpu)?.temperature ?? m.cpu?.temperature;
}
function v2DiskPercent(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.disks, m.primary?.disk)?.percent ?? m.disk?.percent;
}
function v2GpuPercent(m: Record<string, any>): number | undefined {
  const v2 = pickPrimaryEntry<any>(m.gpus, m.primary?.gpu);
  return v2?.usagePercent ?? m.gpu?.usage_percent;
}
function v2GpuTemp(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.gpus, m.primary?.gpu)?.temperature ?? m.gpu?.temperature;
}
function v2Latency(m: Record<string, any>): number | undefined {
  return m.network?.latencyMs ?? m.network?.latency_ms;
}
function v2PacketLoss(m: Record<string, any>): number | undefined {
  return m.network?.packetLossPct ?? m.network?.packet_loss_pct;
}

/** Metric name → path into the metrics object from the machine document */
const METRIC_PATHS: Record<string, (m: Record<string, any>) => number | undefined> = {
  cpu_percent:        v2CpuPercent,
  memory_percent:     (m) => m.memory?.percent,
  disk_percent:       v2DiskPercent,
  gpu_percent:        v2GpuPercent,
  cpu_temp:           v2CpuTemp,
  gpu_temp:           v2GpuTemp,
  network_latency:    v2Latency,
  network_packet_loss:v2PacketLoss,
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

interface DiskSample {
  i: string;   // disk id (e.g. "C:", "L:")
  p: number;   // usage percent
}

interface GpuSample {
  i: string;   // gpu id (e.g. "GPU 0")
  u: number;   // usage percent
  t?: number;  // temperature (optional)
}

interface DiskIOSample {
  i: string;   // volume id (e.g. "C:", "L:")
  rb: number;  // read bytes/sec
  wb: number;  // write bytes/sec
  bu: number;  // busy %
  mb: number;  // max bytes/sec — denominator for read/write %-of-bandwidth chart
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
  ds?: DiskSample[]; // per-disk usage (optional)
  gs?: GpuSample[]; // per-GPU usage (optional)
  dios?: DiskIOSample[]; // per-volume disk IO (optional)
  nl?: number; // network latency ms (gateway ping, optional)
  np?: number; // network packet loss % (gateway ping, optional)
}

/**
 * Triggered when a machine document is written (created or updated).
 * Extracts metrics and appends to the hourly history bucket.
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

    // Get current UTC hour for bucket ID
    const sampleDate = new Date(now * 1000);
    const bucketId = hourlyBucketId(sampleDate);
    const previousBucketId = hourlyBucketId(new Date(sampleDate.getTime() - 60 * 60 * 1000));
    const legacyDayBucketId = dailyBucketId(sampleDate);

    // Path to history document
    const historyRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('metrics_history')
      .doc(bucketId);

    // Check if we should rate limit (avoid duplicate samples within 55 seconds).
    // For the first write into a new hour bucket, also consult the previous hour
    // and legacy daily bucket metadata so hour-boundary/deploy-boundary writes
    // don't accidentally bypass the old daily-doc rate limit.
    try {
      const lastSampleTime = await readLastSampleTime(
        historyRef,
        db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('metrics_history')
          .doc(previousBucketId),
        db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('metrics_history')
          .doc(legacyDayBucketId),
      );

      if (lastSampleTime && now - lastSampleTime < 55) {
        // Too soon since last sample, skip
        console.log(`Rate limiting: last sample was ${now - lastSampleTime}s ago for ${machineId}`);
        return;
      }
    } catch (err) {
      // If we can't check, proceed anyway
      console.warn(`Could not check rate limit for ${machineId}:`, err);
    }

    // Build compact sample object. Read v2 (per-device maps + primary) with
    // fallback to v1 singular fields so in-flight docs still produce samples
    // during the rollout window.
    const cpuPct = v2CpuPercent(metrics);
    const memPct = metrics.memory?.percent;
    const diskPct = v2DiskPercent(metrics);
    const sample: MetricsSample = {
      t: now,
      c: round(cpuPct ?? 0),
      m: round(memPct ?? 0),
      d: round(diskPct ?? 0),
    };

    const gpuPct = v2GpuPercent(metrics);
    if (gpuPct !== undefined && gpuPct !== null) sample.g = round(gpuPct);

    const cpuTemp = v2CpuTemp(metrics);
    if (cpuTemp !== undefined && cpuTemp !== null) sample.ct = round(cpuTemp);

    const gpuTemp = v2GpuTemp(metrics);
    if (gpuTemp !== undefined && gpuTemp !== null) sample.gt = round(gpuTemp);

    const latency = v2Latency(metrics);
    if (latency !== undefined && latency !== null) sample.nl = round(latency);

    const packetLoss = v2PacketLoss(metrics);
    if (packetLoss !== undefined && packetLoss !== null) sample.np = round(packetLoss);

    // Per-NIC network metrics. v2 doc: metrics.nics[id] = { txBps, rxBps, txUtil, rxUtil }.
    // v1 fallback: metrics.network.interfaces[id] = { tx_bps, rx_bps, tx_util, rx_util }.
    const v2Nics = metrics.nics;
    const v1Nics = metrics.network?.interfaces;
    const nicEntries: NicSample[] = [];
    if (v2Nics && typeof v2Nics === 'object') {
      for (const [name, data] of Object.entries(v2Nics)) {
        const nic = data as Record<string, number>;
        if ((nic.txBps ?? 0) > 0 || (nic.rxBps ?? 0) > 0) {
          nicEntries.push({
            i: name,
            tx: Math.round(nic.txBps ?? 0),
            rx: Math.round(nic.rxBps ?? 0),
            tu: round(nic.txUtil ?? 0),
            ru: round(nic.rxUtil ?? 0),
          });
        }
      }
    } else if (v1Nics && typeof v1Nics === 'object') {
      for (const [name, data] of Object.entries(v1Nics)) {
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
    }
    if (nicEntries.length > 0) sample.n = nicEntries;

    // Per-disk usage. v2 doc: metrics.disks[id] = { percent, usedGb }.
    const v2Disks = metrics.disks;
    const diskEntries: DiskSample[] = [];
    if (v2Disks && typeof v2Disks === 'object') {
      for (const [id, data] of Object.entries(v2Disks)) {
        const disk = data as Record<string, number>;
        diskEntries.push({
          i: id,
          p: round(disk.percent ?? 0),
        });
      }
    }
    if (diskEntries.length > 0) sample.ds = diskEntries;

    // Per-GPU usage. v2 doc: metrics.gpus[id] = { name?, usagePercent, temperature?, vramUsedGb }.
    // Use the human-readable `name` for the sample label, falling back to the UUID key.
    const v2Gpus = metrics.gpus;
    const gpuEntries: GpuSample[] = [];
    if (v2Gpus && typeof v2Gpus === 'object') {
      for (const [id, data] of Object.entries(v2Gpus)) {
        const gpu = data as Record<string, any>;
        const entry: GpuSample = {
          i: (typeof gpu.name === 'string' && gpu.name) ? gpu.name : id,
          u: round(gpu.usagePercent ?? 0),
        };
        if (gpu.temperature != null) entry.t = round(gpu.temperature);
        gpuEntries.push(entry);
      }
    }
    if (gpuEntries.length > 0) sample.gs = gpuEntries;

    // Per-volume disk IO. v2 doc: metrics.diskio[id] = { readBps, writeBps, readIops, writeIops, busyPct, maxBps }
    const v2DiskIO = metrics.diskio;
    const diskIOEntries: DiskIOSample[] = [];
    if (v2DiskIO && typeof v2DiskIO === 'object' && !Array.isArray(v2DiskIO)) {
      for (const [id, data] of Object.entries(v2DiskIO)) {
        const vol = data as Record<string, number>;
        const rb = Number.isFinite(vol.readBps) ? Math.round(vol.readBps as number) : 0;
        const wb = Number.isFinite(vol.writeBps) ? Math.round(vol.writeBps as number) : 0;
        const bu = Number.isFinite(vol.busyPct) ? round(vol.busyPct as number) : 0;
        const mb = Number.isFinite(vol.maxBps) ? Math.round(vol.maxBps as number) : 0;
        if (rb > 0 || wb > 0 || bu > 0) {
          diskIOEntries.push({ i: id, rb, wb, bu, mb });
        }
      }
    }
    if (diskIOEntries.length > 0) sample.dios = diskIOEntries;

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

function hourlyBucketId(date: Date): string {
  return date.toISOString().slice(0, 13).replace('T', '-'); // YYYY-MM-DD-HH
}

function dailyBucketId(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readLastSampleTime(
  currentHourRef: FirebaseFirestore.DocumentReference,
  previousHourRef: FirebaseFirestore.DocumentReference,
  legacyDayRef: FirebaseFirestore.DocumentReference,
): Promise<number | null> {
  const currentHourDoc = await currentHourRef.get();
  const currentLastSample = currentHourDoc.data()?.meta?.lastSampleTime;
  if (typeof currentLastSample === 'number') return currentLastSample;

  const [previousHourDoc, legacyDayDoc] = await Promise.all([
    previousHourRef.get(),
    legacyDayRef.get(),
  ]);

  const previousLastSample = previousHourDoc.data()?.meta?.lastSampleTime;
  const legacyLastSample = legacyDayDoc.data()?.meta?.lastSampleTime;
  const candidates = [previousLastSample, legacyLastSample].filter(
    (value): value is number => typeof value === 'number',
  );

  return candidates.length > 0 ? Math.max(...candidates) : null;
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
