/**
 * Webhook dispatch utility for owlette.
 *
 * Fires JSON payloads to all enabled webhooks for a site that subscribe to a
 * given event type.  Non-blocking — uses Promise.allSettled and never throws.
 *
 * Each delivery includes an HMAC-SHA256 signature in the X-owlette-Signature
 * header so receivers can verify authenticity.
 *
 * Auto-disables webhooks after 10 consecutive delivery failures.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { DISPLAY_EVENT_ROUTING } from '@/lib/alerts/displayEventRouting';
import crypto from 'crypto';

export type WebhookPlatform = 'slack' | 'discord' | 'generic';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  site: { id: string; name: string };
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Platform detection & payload formatting                           */
/* ------------------------------------------------------------------ */

/** Detect the target platform from a webhook URL. */
export function detectPlatform(url: string): WebhookPlatform {
  if (url.includes('hooks.slack.com')) return 'slack';
  if (url.includes('discord.com/api/webhooks')) return 'discord';
  return 'generic';
}

interface EventMeta {
  title: string;
  colorHex: string;
  discordColor: number;
}

const DEFAULT_META: EventMeta = { title: 'owlette Event', colorHex: '#6366f1', discordColor: 6526705 };

// Color tokens — keep duplicates aligned with the existing process.* entries
// so a Slack/Discord receiver can deduce severity from color alone across
// event categories. Red = critical, amber = warning, green = healthy,
// indigo = informational.
const COLOR_RED_HEX = '#dc2626';
const COLOR_RED_DISCORD = 14427686;
const COLOR_AMBER_HEX = '#ca8a04';
const COLOR_AMBER_DISCORD = 13273604;
const COLOR_GREEN_HEX = '#16a34a';
const COLOR_GREEN_DISCORD = 1483594;

const EVENT_META: Record<string, EventMeta> = {
  'process.crashed':     { title: 'Process Crashed',      colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'process.restarted':   { title: 'Process Start Failed', colorHex: '#ea580c',       discordColor: 15358988 },
  'machine.offline':     { title: 'Machine Offline',      colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'machine.online':      { title: 'Machine Online',       colorHex: COLOR_GREEN_HEX, discordColor: COLOR_GREEN_DISCORD },
  'threshold.breached':  { title: 'Threshold Alert',      colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },

  // [B1.2] Display events — colors match the severity decisions in plan.md.
  // Critical (red): hardware lost, apply died, sync dropped — operator must
  // notice within seconds. Warning (amber): drift/swap/mosaic — worth a chat
  // channel ping but not loud enough to email. Success (green) and added
  // (neutral) are mostly for the dashboard recent-events feed; they only
  // surface as webhooks if an operator opts in via the routing table.
  'display.monitor_removed':       { title: 'Display Removed',          colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.apply_failed':          { title: 'Display Apply Failed',     colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.auto_revert_fired':     { title: 'Display Auto-Reverted',    colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.sync_lost':             { title: 'Display Sync Lost',        colorHex: COLOR_RED_HEX,   discordColor: COLOR_RED_DISCORD },
  'display.drift':                 { title: 'Display Drift Detected',   colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.monitor_swapped':       { title: 'Display Swapped',          colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.mosaic_disabled':       { title: 'Mosaic Disabled',          colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.apply_refused_mosaic':  { title: 'Display Apply Refused',    colorHex: COLOR_AMBER_HEX, discordColor: COLOR_AMBER_DISCORD },
  'display.monitor_added':         { title: 'Display Added',            colorHex: '#6366f1',       discordColor: 6526705 },
  'display.apply_succeeded':       { title: 'Display Apply Succeeded',  colorHex: COLOR_GREEN_HEX, discordColor: COLOR_GREEN_DISCORD },
};

// Sanity check: the 10 display.* event names registered above must align
// with the central routing table. Missing entries surface as a load-time
// console warning rather than a silent drift between the two sources.
if (process.env.NODE_ENV !== 'production') {
  const missing = Object.values(DISPLAY_EVENT_ROUTING)
    .map((r) => r.webhookEventName)
    .filter((name) => !(name in EVENT_META));
  if (missing.length > 0) {
    console.warn(
      '[webhookSender] EVENT_META missing entries for display events:',
      missing,
    );
  }
}

/** Extract human-readable fields from the webhook data object. */
function extractFields(eventType: string, data: Record<string, unknown>) {
  const machine = data.machine as Record<string, unknown> | undefined;
  const machineName = (machine?.name ?? machine?.id ?? '') as string;

  const processName = ((data.process as Record<string, unknown> | undefined)?.name ?? data.processName ?? '') as string;

  const details = (data.errorMessage ?? data.details ?? '') as string;

  // Threshold-specific
  const metric = data.metric as string | undefined;
  const value = data.value as string | number | undefined;
  const threshold = data.threshold as string | number | undefined;

  // [B1.2] Display-specific. `monitor` is the per-event subject (friendly
  // name + port for the render; edidHash for receivers that want stable
  // identity). `changes` is the per-field list emitted by the agent on
  // drift events (e.g. ["resolution.width", "position.x"]). Neither field
  // is required — view-tab events like `monitor_added` may carry only the
  // monitor; `apply_failed` may carry only an error message.
  const monitor = data.monitor as Record<string, unknown> | undefined;
  const monitorName = (monitor?.friendlyName ?? monitor?.id ?? '') as string;
  const monitorPort = (monitor?.port ?? '') as string;
  const changesRaw = data.changes;
  const changes: string[] = Array.isArray(changesRaw)
    ? changesRaw.filter((c): c is string => typeof c === 'string')
    : [];

  return {
    machineName,
    processName,
    details,
    metric,
    value,
    threshold,
    monitorName,
    monitorPort,
    changes,
  };
}

/**
 * Format a webhook payload for the target platform.
 * Returns the JSON body string to send.
 */
function formatForPlatform(
  platform: WebhookPlatform,
  payload: WebhookPayload,
): string {
  if (platform === 'generic') return JSON.stringify(payload);

  const meta = EVENT_META[payload.event] ?? DEFAULT_META;
  const {
    machineName,
    processName,
    details,
    metric,
    value,
    threshold,
    monitorName,
    monitorPort,
    changes,
  } = extractFields(payload.event, payload.data);

  // Build a summary line for fallback / description
  const summaryParts = [meta.title];
  // For display events the monitor is the more useful subject than the
  // process; substitute it into the summary so Slack's preview text reads
  // "Display Drift Detected: DELL P2415Q on lobby-kiosk-01" rather than
  // generic "Display Drift Detected: on lobby-kiosk-01".
  const isDisplayEvent = payload.event.startsWith('display.');
  if (isDisplayEvent && monitorName) summaryParts.push(monitorName);
  else if (processName) summaryParts.push(processName);
  if (machineName) summaryParts.push(`on ${machineName}`);
  const summary = summaryParts.join(': ');

  // Build a details string
  let detailText = details;
  if (metric && value !== undefined && threshold !== undefined) {
    detailText = `${metric}: ${value} (threshold: ${threshold})`;
  }
  // Display events surface the per-field change list as the detail body —
  // shows the operator exactly which field(s) drifted without forcing them
  // back to the dashboard. Falls back to the generic detail string when
  // the event doesn't carry changes (e.g. apply_failed only has an error).
  if (isDisplayEvent && changes.length > 0) {
    detailText = `Changes: ${changes.join(', ')}`;
  }

  if (platform === 'slack') {
    const blocks: Record<string, unknown>[] = [
      { type: 'header', text: { type: 'plain_text', text: meta.title } },
    ];

    // Fields section. For display events we surface monitor (+ port when
    // present) instead of process, since process isn't meaningful to the
    // operator looking at a display alert.
    const sectionFields: Record<string, unknown>[] = [];
    if (machineName) sectionFields.push({ type: 'mrkdwn', text: `*Machine:*\n${machineName}` });
    if (isDisplayEvent && monitorName) {
      const monitorLabel = monitorPort
        ? `${monitorName} (${monitorPort})`
        : monitorName;
      sectionFields.push({ type: 'mrkdwn', text: `*Monitor:*\n${monitorLabel}` });
    } else if (processName) {
      sectionFields.push({ type: 'mrkdwn', text: `*Process:*\n${processName}` });
    }
    if (sectionFields.length > 0) {
      blocks.push({ type: 'section', fields: sectionFields });
    }

    // Details section
    if (detailText) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: detailText } });
    }

    // Context footer
    const ts = new Date(payload.timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `owlette | ${payload.site.name} | ${ts}` }],
    });

    return JSON.stringify({
      text: summary,
      blocks,
      attachments: [{ color: meta.colorHex }],
    });
  }

  // Discord
  const fields: Record<string, unknown>[] = [];
  if (machineName) fields.push({ name: 'Machine', value: machineName, inline: true });
  if (isDisplayEvent && monitorName) {
    const monitorLabel = monitorPort
      ? `${monitorName} (${monitorPort})`
      : monitorName;
    fields.push({ name: 'Monitor', value: monitorLabel, inline: true });
  } else if (processName) {
    fields.push({ name: 'Process', value: processName, inline: true });
  }
  fields.push({ name: 'Site', value: payload.site.name, inline: true });

  return JSON.stringify({
    embeds: [{
      title: meta.title,
      description: detailText || undefined,
      color: meta.discordColor,
      fields,
      timestamp: payload.timestamp,
      footer: { text: 'owlette' },
    }],
  });
}

/**
 * Fire all enabled webhooks for a site that subscribe to the given event.
 * Non-blocking — uses Promise.allSettled, never throws.
 *
 * @returns The number of webhooks that were successfully delivered.
 */
export async function fireWebhooks(
  siteId: string,
  siteName: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<number> {
  const db = getAdminDb();

  // Query enabled webhooks that subscribe to this event
  const snapshot = await db
    .collection(`sites/${siteId}/webhooks`)
    .where('enabled', '==', true)
    .where('events', 'array-contains', eventType)
    .get();

  if (snapshot.empty) return 0;

  const payload: WebhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    site: { id: siteId, name: siteName },
    data,
  };

  let successCount = 0;

  const deliveries = snapshot.docs.map(async (doc) => {
    const webhook = doc.data();
    try {
      const platform = detectPlatform(webhook.url);
      const body = formatForPlatform(platform, payload);

      // Build headers — skip HMAC for Slack/Discord (they don't use it)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'owlette-Webhooks/1.0',
      };

      if (platform === 'generic') {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');
        headers['X-owlette-Signature'] = `sha256=${signature}`;
        headers['X-owlette-Event'] = eventType;
      }

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });

      const newFailCount = response.ok ? 0 : (webhook.failCount || 0) + 1;

      // Update delivery status
      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: response.status,
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }

      if (response.ok) successCount++;
    } catch {
      const newFailCount = (webhook.failCount || 0) + 1;

      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: 0, // network error
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }
    }
  });

  await Promise.allSettled(deliveries);
  return successCount;
}

/**
 * Send a test payload to a specific webhook. Returns the HTTP status code
 * or 0 on network error.
 */
export async function testWebhook(
  url: string,
  secret: string
): Promise<{ status: number; error?: string }> {
  const platform = detectPlatform(url);

  // Use a realistic test payload so Slack/Discord render a proper preview
  const payload: WebhookPayload = {
    event: 'process.crashed',
    timestamp: new Date().toISOString(),
    site: { id: 'test', name: 'Test Site' },
    data: {
      machine: { name: 'MEDIA-SERVER-01' },
      process: { name: 'TouchDesigner' },
      details: 'This is a test webhook from owlette.',
    },
  };

  const body = formatForPlatform(platform, payload);

  // Build headers — skip HMAC for Slack/Discord
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'owlette-Webhooks/1.0',
  };

  if (platform === 'generic') {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    headers['X-owlette-Signature'] = `sha256=${signature}`;
    headers['X-owlette-Event'] = 'test';
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    return { status: response.status };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Network error';
    return { status: 0, error: message };
  }
}
