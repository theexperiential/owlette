/**
 * Talon Log-Event Bridge
 *
 * Firestore trigger on `sites/{siteId}/logs/{logId}` that forwards the fleet
 * events talons can subscribe to but no web route ever sees.
 *
 * Why this exists: most agent events reach the dashboard through an http
 * endpoint (`/api/agent/alert`, `/api/alerts/trigger`) which can tap the talon
 * matcher in-process. `process_restarted` and the `display_*` events do not —
 * the agent writes them STRAIGHT into the site's log collection. (The
 * `send_display_alert` helper that would have posted them to `/api/agent/alert`
 * has zero call sites.) Without this trigger, a talon subscribed to
 * `display_drift` or `process_restarted` could never fire.
 *
 * Matching events are forwarded to `POST /api/talons/internal/match`, which
 * runs the matcher exactly as the in-process taps do. Failures are logged, never
 * thrown: a log write must not be retried because a talon run had a bad day.
 *
 * talons wave 2, task 2.3.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import https = require('https');
import http = require('http');

/**
 * The `action` values worth forwarding.
 *
 * MUST stay a subset of `TALON_EVENT_TYPES` in `web/lib/talons/types.ts`, and
 * mirrors the ten keys of `DISPLAY_EVENT_ROUTING` in
 * `web/lib/alerts/displayEventRouting.ts` plus `process_restarted`. Duplicated
 * rather than imported because functions/ and web/ are separate packages with
 * separate builds; the internal match route re-validates against the real
 * catalog, so drift here degrades to "the event is never forwarded", not to a
 * bad write.
 *
 * Deliberately EXCLUDED — the display audit actions that exist for the event
 * feed and have no routing entry, so no talon can subscribe to them:
 * `display_auto_restore_fired`, `display_apply_acked`, `display_revert_deferred`,
 * `display_auto_restore_skipped_unfixable`,
 * `display_auto_restore_circuit_breaker_tripped`.
 *
 * Also excluded by construction: the engine's own `talon_triggered` /
 * `talon_succeeded` / `talon_failed` / `talon_skipped` companion logs, which is
 * what keeps a talon run from re-triggering itself through this bridge.
 */
const TALON_LOG_ACTIONS: ReadonlySet<string> = new Set([
  'process_restarted',
  // DISPLAY_EVENT_ROUTING keys — email + webhook
  'display_monitor_removed',
  'display_apply_failed',
  'display_auto_revert_fired',
  'display_sync_lost',
  // DISPLAY_EVENT_ROUTING keys — webhook only
  'display_drift',
  'display_monitor_swapped',
  'display_mosaic_disabled',
  'display_apply_refused_mosaic',
  // DISPLAY_EVENT_ROUTING keys — in-dashboard only
  'display_monitor_added',
  'display_apply_succeeded',
]);

/** Sentinel the talon engine writes for a site-level run — never a real machine. */
const SITE_LOG_SENTINEL = 'site';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Derive the web API base URL from the Firebase project ID — the same heuristic
 * `metricsHistory.ts` uses, so both bridges follow one deployment convention.
 */
function getApiBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
  if (projectId.includes('dev')) return 'https://dev.owlette.app';
  return 'https://owlette.app';
}

/**
 * POST to `/api/talons/internal/match` on the web server, using the built-in
 * node http/https modules (no external deps), mirroring `callAlertTriggerApi`.
 */
function callTalonMatchApi(body: Record<string, unknown>): Promise<void> {
  const baseUrl = process.env.API_BASE_URL || getApiBaseUrl();
  const secret = process.env.CORTEX_INTERNAL_SECRET;

  if (!secret) {
    console.warn('CORTEX_INTERNAL_SECRET not configured — skipping talon match');
    return Promise.resolve();
  }

  const url = new URL('/api/talons/internal/match', baseUrl);
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
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        // Consume the response body to free resources
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Talon match API returned status ${res.statusCode}`));
        }
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Talon match API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Forward talon-relevant log entries to the matcher.
 *
 * Cheap by construction: one read of the created document, a set lookup on
 * `action`, and an immediate return for everything else. The site log stream
 * carries every command, deployment and audit line in the fleet, so the
 * overwhelming majority of invocations do no work and touch Firestore not at all.
 */
export const onTalonLogEventCreated = onDocumentCreated(
  'sites/{siteId}/logs/{logId}',
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const action = typeof data.action === 'string' ? data.action : '';
    if (!TALON_LOG_ACTIONS.has(action)) return;

    const { siteId } = event.params;
    const rawMachineId = typeof data.machineId === 'string' ? data.machineId : '';
    // The sentinel means "no machine", and forwarding it would let a
    // machine-scoped talon match a site that happens to own a machine called
    // `site`. Omitted instead, which the matcher reads as a site-level event.
    const machineId = rawMachineId && rawMachineId !== SITE_LOG_SENTINEL ? rawMachineId : '';

    try {
      await callTalonMatchApi({
        siteId,
        eventType: action,
        ...(machineId ? { machineId } : {}),
      });
    } catch (err) {
      // Never rethrow: a retried invocation would re-run every matching talon,
      // and the log entry itself is already durable.
      console.error(`Failed to forward ${action} on ${siteId} to the talon matcher:`, err);
    }
  }
);
