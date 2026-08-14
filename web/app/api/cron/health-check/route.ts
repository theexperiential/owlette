import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteAlertRecipients, getSiteLabel } from '@/lib/adminUtils.server';
import { getResend, FROM_EMAIL } from '@/lib/resendClient.server';
import { wrapEmailLayout, EMAIL_COLORS, emailTimestamp, escapeHtml, safeEmailSubject } from '@/lib/emailTemplates.server';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { fireWebhooks } from '@/lib/webhookSender.server';
import { tapTalonMatcher } from '@/lib/talons/matcher.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  alertEmailsDisabled,
  type TrialLifecycleCustomer,
} from '@/lib/billing/trialLifecycle.server';
import { createWebhookBillingCache } from '@/lib/billing/webhookDelivery.server';

/**
 * GET /api/cron/health-check
 *
 * Railway HTTP cron endpoint that scans all machines for stale heartbeats
 * and sends email alerts to site admins when machines appear offline.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * Deduplication: Writes health.lastCronAlertAt to Firestore after sending,
 * preventing repeat emails within ALERT_COOLDOWN_MS (default: 1 hour).
 *
 * Railway cron config (set in Railway dashboard):
 *   Schedule:  * /5 * * * *   (every 5 minutes)
 *   URL:       GET https://<your-app>/api/cron/health-check
 *   Header:    X-Cron-Secret: <CRON_SECRET value>
 */

// A machine is considered offline if its heartbeat is older than this. Sized well
// clear of the agent's 120s idle heartbeat cadence (agent/src/firebase_client.py)
// so two consecutive missed beats still don't trip it — at 3 minutes a single slow
// tick was enough to mark a healthy machine stale.
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Don't re-alert for the same machine within this window
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Suppress offline alerts while a machine is inside an announced reboot/shutdown
// window. Before issuing the OS restart the agent atomically publishes a boolean
// (`rebooting` / `shuttingDown`) AND the target instant (`rebootScheduledAt` /
// `shutdownScheduledAt`, Unix seconds), and clears them on the first post-boot
// heartbeat (or on cancel). We require BOTH the boolean (the agent currently
// claims downtime) AND the target instant to fall inside a bounded window around
// "now": up to GRACE *after* the target (cold boot + delayed autostart + auth) and
// up to GRACE *before* it (tolerate modest agent-clock skew on the agent-computed
// instant). Bounding both sides means a stuck boolean paired with a far-future
// (clock-skewed) instant can't suppress a real outage indefinitely; requiring the
// boolean means a stale instant left behind by a cancel won't suppress either.
const PLANNED_DOWNTIME_GRACE_MS = 15 * 60 * 1000; // 15 minutes, applied symmetrically

// Debounce: the idle heartbeat cadence is 120s, so a short run of missed beats can
// push a healthy machine past OFFLINE_THRESHOLD_MS. Require the machine to still be
// stale on a later scan — at least this long after first observed stale — before
// emailing, so a transient gap never pages.
const STALE_CONFIRM_MS = OFFLINE_THRESHOLD_MS; // ~one extra cron interval of confirmed staleness

// Site-level settling window. A machine confirmed not-responding is added to the
// site's pending set rather than emailed immediately; the consolidated alert is
// only sent once the pending set has stopped GROWING for this long. Sized as the
// 5-minute cron interval plus margin so a staggered shutdown (machines crossing to
// offline across several scans) coalesces into ONE email with the full count,
// instead of a burst of disjoint partial-count batches. The trade-off is a small
// added latency (~one extra cron interval) before the first offline email.
const SETTLE_MS = 7 * 60 * 1000; // 7 minutes (cron interval + margin)

// A machine that gracefully announced shutdown (online:false) with a heartbeat at
// least this recent is shown as context ("reported shutting down") in the offline
// email — recent enough to belong to the current outage picture, not a box that
// was decommissioned or powered down days ago.
const RECENT_SHUTDOWN_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

function timestampToMillis(value: unknown): number {
  return (value as FirebaseFirestore.Timestamp | null)?.toMillis?.() ?? 0;
}

function unixSecondsOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface MachineHealthSnapshot {
  online: boolean;
  lastHeartbeatMs: number;
  lastCronAlertAtMs: number;
  staleSinceMs: number;
  rebooting: boolean;
  shuttingDown: boolean;
  rebootScheduledAtSec: number; // Unix seconds, 0 when unset
  shutdownScheduledAtSec: number; // Unix seconds, 0 when unset
}

/**
 * True when the machine is inside an announced reboot/shutdown window. Requires
 * the agent's in-progress boolean AND the target instant within ±GRACE of `now`
 * (see PLANNED_DOWNTIME_GRACE_MS) — so neither a stale instant left behind by a
 * cancel nor a clock-skewed far-future instant can suppress a real outage.
 */
function plannedDowntimeActive(inProgress: boolean, scheduledAtSec: number, now: number): boolean {
  if (inProgress !== true || scheduledAtSec <= 0) return false;
  const scheduledAtMs = scheduledAtSec * 1000;
  return (
    now >= scheduledAtMs - PLANNED_DOWNTIME_GRACE_MS &&
    now < scheduledAtMs + PLANNED_DOWNTIME_GRACE_MS
  );
}

/**
 * Once an announced reboot/shutdown window has fully elapsed (target instant more
 * than GRACE in the past) but the agent's latch is still set, the latch is stale
 * and must be cleared at the source: a completed shutdown can never clear its own
 * latch (the box is powered off), and a failed/never-returning reboot leaves
 * `rebooting` set with no clearer — either would otherwise pulse the status pill
 * indefinitely for every client. Each flag is evaluated independently against its
 * own window, so an in-progress reboot still within grace is left untouched. We
 * anchor on `scheduledAt` (not heartbeat) so a just-set latch whose anchor hasn't
 * landed yet is never cleared prematurely.
 */
export function stalePlannedDowntime(
  m: MachineHealthSnapshot,
  now: number
): { clearShutdown: boolean; clearReboot: boolean } {
  const elapsed = (inProgress: boolean, scheduledAtSec: number) =>
    inProgress === true &&
    scheduledAtSec > 0 &&
    now >= scheduledAtSec * 1000 + PLANNED_DOWNTIME_GRACE_MS;
  return {
    clearShutdown: elapsed(m.shuttingDown, m.shutdownScheduledAtSec),
    clearReboot: elapsed(m.rebooting, m.rebootScheduledAtSec),
  };
}

export type HealthDecision =
  | { action: 'ok' } // online + fresh heartbeat — clear any stale marker
  | { action: 'ignore'; reason: 'offline-flag' | 'planned-downtime' | 'cooldown' }
  | { action: 'debounce' } // stale but not yet confirmed — record staleSince, don't alert yet
  | { action: 'alert'; heartbeatAgeMinutes: number };

/**
 * Pure per-machine offline decision. Kept side-effect-free so it can be unit
 * tested directly (the GET handler maps the decision to Firestore writes/emails).
 */
export function classifyMachineHealth(m: MachineHealthSnapshot, now: number): HealthDecision {
  // Only machines the agent last reported online can transition to "offline".
  if (m.online !== true) return { action: 'ignore', reason: 'offline-flag' };

  const heartbeatAge = now - m.lastHeartbeatMs;
  if (heartbeatAge <= OFFLINE_THRESHOLD_MS) return { action: 'ok' };

  // Planned downtime: the agent announced a reboot/shutdown that is plausibly
  // happening right now (boolean set + target instant within ±grace). Don't page.
  if (
    plannedDowntimeActive(m.rebooting, m.rebootScheduledAtSec, now) ||
    plannedDowntimeActive(m.shuttingDown, m.shutdownScheduledAtSec, now)
  ) {
    return { action: 'ignore', reason: 'planned-downtime' };
  }

  // Already alerted within the cooldown window.
  if (now - m.lastCronAlertAtMs <= ALERT_COOLDOWN_MS) {
    return { action: 'ignore', reason: 'cooldown' };
  }

  // Debounce: require sustained staleness across scans before paging.
  if (m.staleSinceMs <= 0 || now - m.staleSinceMs < STALE_CONFIRM_MS) {
    return { action: 'debounce' };
  }

  return { action: 'alert', heartbeatAgeMinutes: Math.floor(heartbeatAge / 60000) };
}

// A machine that is confirmed not-responding this scan, carried through the
// site-level settling aggregation and (once settled) into the alert email. The
// ref is retained so the per-machine cooldown stamp can be written at send time.
interface PendingMachine {
  machineId: string;
  ref: FirebaseFirestore.DocumentReference;
  lastHeartbeatMs: number;
  heartbeatAgeMinutes: number;
  timezone?: string;
}

// A single machine row rendered in one of the offline email's sections.
interface OfflineRow {
  machineId: string;
  heartbeatAgeMinutes: number;
}

// The three buckets that together describe a site's full offline picture, so the
// email's count always reconciles with reality.
interface OfflineSections {
  notResponding: OfflineRow[]; // confirmed stale with no shutdown announcement — the page trigger
  shuttingDown: OfflineRow[]; // online:false with a recent heartbeat — graceful, context only
  stillOffline: OfflineRow[]; // stale but inside their per-machine re-alert cooldown — context only
}

// A settled per-site alert, queued during the scan phase and emailed afterwards.
interface SendPlan {
  siteId: string;
  siteName: string;
  // The site's billing customer (`sites/{siteId}.owner`), read off the doc the
  // scan already loaded. Drives the post-expiry alert cutoff below; `null` for
  // an ownerless (legacy / partially-written) site, which never suppresses.
  ownerUid: string | null;
  sections: OfflineSections;
  webhookMachines: { machineId: string; lastHeartbeatMs: number }[];
  timezone?: string;
}

/**
 * Whether this account's offline alert emails have been cut off — the last row
 * of the plan's lockout matrix: an expired account keeps getting paged about
 * dead machines for 30 days, then those stop.
 *
 * The decision itself is `alertEmailsDisabled()` (wave 2.2), which requires
 * BOTH the `alertEmailsDisabledAt` stamp written by
 * `/api/cron/billing-trial-lifecycle` AND the account still resolving
 * `'expired'` — so a customer who converts gets their alerts back immediately
 * rather than waiting on the next nightly sweep.
 *
 * Cost: one `customers/{uid}` read per *distinct owner* per run, memoised in
 * `cache`, and only for sites that actually have a settled alert to send. A
 * fleet under one owner pays for one read no matter how many sites alert.
 *
 * Fails OPEN on any read error — the same posture as `getBillingSnapshot()`.
 * Losing a page about a dead machine because a billing lookup hiccuped is far
 * worse than sending one alert to an account that had gone quiet.
 */
async function alertEmailsCutOff(
  db: FirebaseFirestore.Firestore,
  ownerUid: string | null,
  now: number,
  cache: Map<string, boolean>
): Promise<boolean> {
  if (!ownerUid) return false;

  const cached = cache.get(ownerUid);
  if (cached !== undefined) return cached;

  let cutOff = false;
  try {
    const snap = await db.collection('customers').doc(ownerUid).get();
    cutOff =
      snap.exists &&
      alertEmailsDisabled(snap.data() as TrialLifecycleCustomer | undefined, new Date(now));
  } catch (error) {
    console.error(`[cron/health-check] Billing lookup failed for owner ${ownerUid}:`, error);
  }

  cache.set(ownerUid, cutOff);
  return cutOff;
}

function heartbeatAgeMinutes(lastHeartbeatMs: number, now: number): number {
  if (lastHeartbeatMs <= 0) return 0;
  return Math.max(0, Math.floor((now - lastHeartbeatMs) / 60000));
}

function offlineRowsHtml(rows: OfflineRow[]): string {
  return rows
    .map(
      (r) => `
      <tr>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.text};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${escapeHtml(r.machineId)}</td>
        <td style="padding:10px 14px;color:${EMAIL_COLORS.muted};border-bottom:1px solid ${EMAIL_COLORS.border};font-size:13px;">${r.heartbeatAgeMinutes} minute(s) ago</td>
      </tr>`
    )
    .join('');
}

function offlineSectionHtml(label: string, description: string, accent: string, rows: OfflineRow[]): string {
  if (rows.length === 0) return '';
  return `
    <p style="margin:22px 0 6px;color:${accent};font-size:13px;font-weight:700;text-transform:lowercase;">${label} (${rows.length})</p>
    <p style="margin:0 0 10px;color:${EMAIL_COLORS.muted};font-size:12px;">${description}</p>
    <table width="100%" style="border-collapse:collapse;border:1px solid ${EMAIL_COLORS.border};border-radius:6px;overflow:hidden;" cellpadding="0" cellspacing="0">
      <thead>
        <tr>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">machine</th>
          <th style="padding:10px 14px;text-align:left;background:${EMAIL_COLORS.altRow};color:${EMAIL_COLORS.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${EMAIL_COLORS.border};">last seen</th>
        </tr>
      </thead>
      <tbody>${offlineRowsHtml(rows)}</tbody>
    </table>`;
}

/**
 * Build the consolidated offline email for a site. Sections describe the full
 * picture — machines that stopped responding (the page trigger) plus the two
 * context buckets (graceful shutdowns and machines still down from an earlier
 * alert). The subject count (computed by the caller) matches the total number of
 * machines listed here, so the count always reconciles with the body.
 */
function buildOfflineEmail(
  siteLabel: string,
  sections: OfflineSections,
  timezone?: string,
  unsubscribeUrl?: string
): string {
  const total = sections.notResponding.length + sections.shuttingDown.length + sections.stillOffline.length;

  const content = `
    <h2 style="color:${EMAIL_COLORS.red};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">machines offline</h2>
    <p style="margin:0 0 4px;color:${EMAIL_COLORS.muted};">${total} machine(s) in site <strong style="color:${EMAIL_COLORS.text};">${escapeHtml(siteLabel)}</strong> are offline or not responding.</p>
    ${offlineSectionHtml('not responding', 'no heartbeat received — these machines may have crashed or lost their connection.', EMAIL_COLORS.red, sections.notResponding)}
    ${offlineSectionHtml('reported shutting down', 'the agent announced a shutdown before going offline.', EMAIL_COLORS.amber, sections.shuttingDown)}
    ${offlineSectionHtml('still offline', 'already alerted earlier and still not responding.', EMAIL_COLORS.muted, sections.stillOffline)}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">please check each machine and verify that the owlette service is running.</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">checked at ${emailTimestamp(new Date(), timezone)}</p>
    <p style="margin:8px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">alerts are sent at most once per hour per machine.</p>
  `;

  return wrapEmailLayout(content, {
    unsubscribeUrl,
    preheader: `${total} machine(s) offline in ${siteLabel}`,
  });
}

/**
 * Drop machines the recipient has muted from every section. The not-responding
 * set is the page trigger; if the user muted all of it, the caller skips them.
 */
function filterSectionsForRecipient(sections: OfflineSections, mutedMachines: string[]): OfflineSections {
  if (mutedMachines.length === 0) return sections;
  const muted = new Set(mutedMachines);
  const keep = (r: OfflineRow) => !muted.has(r.machineId);
  return {
    notResponding: sections.notResponding.filter(keep),
    shuttingDown: sections.shuttingDown.filter(keep),
    stillOffline: sections.stillOffline.filter(keep),
  };
}

/**
 * Merge-write the site-level offline-alert state (health.offlineAlert). Isolated
 * in its own try/catch so a failed site-doc write degrades gracefully (logged)
 * without aborting the run — per-machine writes and every other site still
 * process. `merge:true` deep-merges the nested map, so this only touches the
 * fields supplied here and leaves the rest of health.* untouched.
 */
async function writeSiteOfflineState(
  ref: FirebaseFirestore.DocumentReference,
  siteId: string,
  opts: {
    pendingIds?: string[];
    bumpPendingUpdatedAt?: boolean;
    clearPendingUpdatedAt?: boolean;
    setLastAlertAt?: boolean;
  }
): Promise<void> {
  const offlineAlert: Record<string, unknown> = {};
  if (opts.pendingIds !== undefined) offlineAlert.pendingIds = opts.pendingIds;
  if (opts.bumpPendingUpdatedAt) offlineAlert.pendingUpdatedAt = FieldValue.serverTimestamp();
  else if (opts.clearPendingUpdatedAt) offlineAlert.pendingUpdatedAt = FieldValue.delete();
  if (opts.setLastAlertAt) offlineAlert.lastAlertAt = FieldValue.serverTimestamp();

  try {
    await ref.set({ health: { offlineAlert } }, { merge: true });
  } catch (error) {
    console.error(`[cron/health-check] Failed to persist offline state for site ${siteId}:`, error);
  }
}

export async function GET(request: NextRequest) {
  // Validate cron secret
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = Date.now();
  const sendPlans: SendPlan[] = [];
  let sitesChecked = 0;
  let machinesChecked = 0;
  let offlineMachines = 0;

  try {
    const sitesSnap = await db.collection('sites').get();
    sitesChecked = sitesSnap.size;

    for (const siteDoc of sitesSnap.docs) {
      const siteId = siteDoc.id;
      const siteData = siteDoc.data();

      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      machinesChecked += machinesSnap.size;

      // Buckets for this site: the page trigger plus the two context sections.
      const notResponding: PendingMachine[] = [];
      const shuttingDown: OfflineRow[] = [];
      const stillOffline: OfflineRow[] = [];

      for (const machineDoc of machinesSnap.docs) {
        const machine = machineDoc.data();

        const lastHeartbeatMs = timestampToMillis(machine.lastHeartbeat);
        const staleSinceMs = timestampToMillis(machine.health?.staleSince);
        // Prefer the IANA name (the only value Intl accepts); the sibling
        // machine_timezone holds the Windows registry name and would fall back
        // to UTC in emailTimestamp.
        const timezone = machine.machine_timezone_iana || machine.machine_timezone || undefined;

        const snapshot: MachineHealthSnapshot = {
          online: machine.online === true,
          lastHeartbeatMs,
          lastCronAlertAtMs: timestampToMillis(machine.health?.lastCronAlertAt),
          staleSinceMs,
          rebooting: machine.rebooting === true,
          shuttingDown: machine.shuttingDown === true,
          rebootScheduledAtSec: unixSecondsOrZero(machine.rebootScheduledAt),
          shutdownScheduledAtSec: unixSecondsOrZero(machine.shutdownScheduledAt),
        };

        // Clear stale reboot/shutdown latches at the source. A completed shutdown
        // never powers back on to clear its own latch, and a failed reboot never
        // returns to clear it — once the announced window has elapsed past grace,
        // null the flags so the status pill is correct for every client, not just
        // the one whose heartbeat-derived `online` has already gone stale. This is
        // a one-shot write: after it lands the flags are gone, so later scans skip
        // it. Runs before the alert decision so it applies regardless of outcome.
        const stale = stalePlannedDowntime(snapshot, now);
        if (stale.clearShutdown || stale.clearReboot) {
          const clearPayload: Record<string, unknown> = {};
          if (stale.clearShutdown) {
            clearPayload.shuttingDown = false;
            clearPayload.shutdownScheduledAt = FieldValue.delete();
          }
          if (stale.clearReboot) {
            clearPayload.rebooting = false;
            clearPayload.rebootScheduledAt = FieldValue.delete();
            clearPayload.rebootCancellable = false;
          }
          await machineDoc.ref.set(clearPayload, { merge: true });
        }

        const decision = classifyMachineHealth(snapshot, now);

        if (decision.action === 'ok') {
          // Heartbeat recovered — drop any stale marker so the next outage
          // debounces cleanly from scratch. Removal from the site's pending set
          // (if it was there) happens in the aggregation below.
          if (staleSinceMs > 0) {
            await machineDoc.ref.set(
              { health: { staleSince: FieldValue.delete() } },
              { merge: true }
            );
          }
          continue;
        }

        if (decision.action === 'debounce') {
          // First scan we've seen this machine stale — record when. We only
          // alert if it's still stale on a later scan (guards against a
          // transient gap in the 120s idle heartbeat).
          if (staleSinceMs <= 0) {
            await machineDoc.ref.set(
              { health: { staleSince: FieldValue.serverTimestamp() } },
              { merge: true }
            );
          }
          continue;
        }

        if (decision.action === 'alert') {
          // Confirmed not-responding. Do NOT email or stamp cooldown yet — feed
          // it into the site's settling aggregation below.
          notResponding.push({
            machineId: machineDoc.id,
            ref: machineDoc.ref,
            lastHeartbeatMs,
            heartbeatAgeMinutes: decision.heartbeatAgeMinutes,
            timezone,
          });
          continue;
        }

        // decision.action === 'ignore' — never a page trigger, but a machine can
        // still belong to the email's context sections so the count is complete.
        if (
          machine.online === false &&
          lastHeartbeatMs > 0 &&
          now - lastHeartbeatMs <= RECENT_SHUTDOWN_WINDOW_MS
        ) {
          // The agent explicitly flushed online:false — a graceful shutdown.
          shuttingDown.push({
            machineId: machineDoc.id,
            heartbeatAgeMinutes: heartbeatAgeMinutes(lastHeartbeatMs, now),
          });
        } else if (decision.reason === 'cooldown') {
          // Still stale, already alerted within the last hour.
          stillOffline.push({
            machineId: machineDoc.id,
            heartbeatAgeMinutes: heartbeatAgeMinutes(lastHeartbeatMs, now),
          });
        }
      }

      // --- Site-level settling aggregation -----------------------------------
      // Persist the pending (not-responding) set on the site doc and only fire
      // once it has stopped growing for SETTLE_MS, so a staggered shutdown emits
      // ONE consolidated email instead of a burst of partial-count batches.
      const priorState = (siteData.health?.offlineAlert ?? {}) as {
        pendingIds?: unknown;
        pendingUpdatedAt?: unknown;
      };
      const priorPendingIds = Array.isArray(priorState.pendingIds)
        ? (priorState.pendingIds as string[])
        : [];
      const priorPendingSet = new Set(priorPendingIds);
      const priorPendingUpdatedAtMs = timestampToMillis(priorState.pendingUpdatedAt);

      const currentIds = notResponding.map((m) => m.machineId);
      const currentSet = new Set(currentIds);
      const newIdAdded = currentIds.some((id) => !priorPendingSet.has(id));
      const idRemoved = priorPendingIds.some((id) => !currentSet.has(id));

      if (currentIds.length === 0) {
        // Nothing not-responding right now. Clear any lingering pending state so
        // a future outage settles from a clean slate. (Recovered/settled machines
        // both land here.)
        if (priorPendingIds.length > 0) {
          await writeSiteOfflineState(siteDoc.ref, siteId, {
            pendingIds: [],
            clearPendingUpdatedAt: true,
          });
        }
        continue;
      }

      // Reset the settle timer only when a NEW machine joins the set (a growing
      // outage keeps settling). A missing timestamp forces one more cycle rather
      // than firing immediately on partial state.
      const bump = newIdAdded || priorPendingUpdatedAtMs <= 0;
      const settled = !bump && now - priorPendingUpdatedAtMs >= SETTLE_MS;

      if (!settled) {
        // Still settling — persist the current set (bumping the timer only on
        // growth; removals keep the existing timer running). Skip the write when
        // nothing changed to avoid needless churn.
        if (bump || idRemoved) {
          await writeSiteOfflineState(siteDoc.ref, siteId, {
            pendingIds: currentIds,
            bumpPendingUpdatedAt: bump,
          });
        }
        continue;
      }

      // Settled — commit the consolidated alert. Stamp each pending machine's
      // per-machine cooldown (preserving the ~1h re-alert cadence, now naturally
      // consolidated per site) and clear the pending set BEFORE sending, so a
      // send failure can never loop into repeated re-alerts. Each write degrades
      // independently.
      for (const m of notResponding) {
        try {
          await m.ref.set(
            { health: { lastCronAlertAt: FieldValue.serverTimestamp() } },
            { merge: true }
          );
        } catch (error) {
          console.error(`[cron/health-check] Failed to stamp cooldown for ${siteId}/${m.machineId}:`, error);
        }
      }
      await writeSiteOfflineState(siteDoc.ref, siteId, {
        pendingIds: [],
        clearPendingUpdatedAt: true,
        setLastAlertAt: true,
      });

      offlineMachines += notResponding.length;
      const rawOwner = siteData.owner;
      sendPlans.push({
        siteId,
        siteName: (siteData.name as string) || siteId,
        ownerUid: typeof rawOwner === 'string' && rawOwner.length > 0 ? rawOwner : null,
        sections: {
          notResponding: notResponding.map(({ machineId, heartbeatAgeMinutes }) => ({ machineId, heartbeatAgeMinutes })),
          shuttingDown,
          stillOffline,
        },
        webhookMachines: notResponding.map(({ machineId, lastHeartbeatMs }) => ({ machineId, lastHeartbeatMs })),
        timezone: notResponding[0]?.timezone,
      });
    }
  } catch (error) {
    return apiError(error, 'cron/health-check');
  }

  if (sendPlans.length === 0) {
    return NextResponse.json({
      ok: true,
      sitesChecked,
      machinesChecked,
      offlineMachines: 0,
      alertsSent: 0,
      alertsSuppressed: 0,
    });
  }

  const resendClient = getResend();
  const baseUrl = request.nextUrl.origin;
  // One entry per distinct site owner, for the whole run.
  const billingCutoffCache = new Map<string, boolean>();
  // Separate memo for the webhook-delivery gate (wave 2.6). It answers a
  // different question than the email cutoff — "is the account locked out?"
  // vs. "is it 30 days past expiry?" — so the two can't share a map.
  const webhookBillingCache = createWebhookBillingCache();
  let alertsSent = 0;
  let alertsSuppressed = 0;

  for (const plan of sendPlans) {
    try {
      // Billing lockout, last row of the plan's matrix: 30 days past trial
      // expiry the emails stop. Only the EMAILS — webhook delivery pauses on
      // a different clock (the moment the account locks out, not 30 days
      // later), and is gated inside `fireWebhooks` below.
      if (await alertEmailsCutOff(db, plan.ownerUid, now, billingCutoffCache)) {
        alertsSuppressed++;
        console.log(
          `[cron/health-check] Alert emails cut off for site ${plan.siteId} ` +
            `(account expired past the post-expiry grace)`
        );
      } else {
        const recipients = await getSiteAlertRecipients(plan.siteId, 'healthAlerts');
        if (recipients.length === 0) {
          console.warn(`[cron/health-check] No recipients for site ${plan.siteId}`);
          continue;
        }

        if (!resendClient) {
          console.warn('[cron/health-check] Resend not configured — skipping email');
          continue;
        }

        const siteLabel = await getSiteLabel(plan.siteId);

        // Send individual emails so each user gets their own unsubscribe link
        for (const recipient of recipients) {
          try {
            const sections = filterSectionsForRecipient(plan.sections, recipient.mutedMachines);
            // The not-responding set is the page trigger; if the user muted every
            // triggering machine, they've opted out of this page — skip them even
            // if context rows remain.
            if (sections.notResponding.length === 0) continue;

            const total = sections.notResponding.length + sections.shuttingDown.length + sections.stillOffline.length;

            const unsubscribeUrl = recipient.userId !== 'fallback'
              ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
              : undefined;

            const result = await resendClient.emails.send({
              from: FROM_EMAIL,
              to: [recipient.email],
              ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
              subject: safeEmailSubject(`${total} machine(s) offline in ${siteLabel}`),
              html: buildOfflineEmail(siteLabel, sections, plan.timezone, unsubscribeUrl),
            });

            if (result.error) {
              console.error(`[cron/health-check] Resend error for ${recipient.email}:`, result.error);
            } else {
              alertsSent++;
            }
          } catch (emailError) {
            console.error(`[cron/health-check] Failed to send to ${recipient.email}:`, emailError);
          }
        }

        console.log(
          `[cron/health-check] Alert sent for site ${plan.siteId}: ` +
            `${plan.sections.notResponding.length} not responding, ${recipients.length} recipient(s)`
        );
      }

      // Fire webhooks for each not-responding machine (non-blocking).
      // `webhookBillingCache` is shared across the whole run so a fleet of
      // dead machines under one owner costs one billing lookup, not one per
      // machine — and the gate stays live, so a mid-run conversion is picked
      // up by the next run with nothing to invalidate.
      for (const m of plan.webhookMachines) {
        fireWebhooks(
          plan.siteId,
          plan.siteName,
          'machine.offline',
          {
            machine: { id: m.machineId, name: m.machineId, lastSeen: new Date(m.lastHeartbeatMs).toISOString() },
          },
          { billingCache: webhookBillingCache }
        ).catch(console.error);

        // Talon tap. Deliberately alongside the WEBHOOK fan-out and not the
        // email branch above: the email is skipped wholesale for a
        // billing-expired owner, and `machine_offline` talons — which is where
        // an operator's own escalation lives — must not silently stop firing
        // on the same clock. This is also the only dispatcher for the event;
        // an offline machine cannot report that it is offline.
        tapTalonMatcher(db, plan.siteId, {
          kind: 'event',
          eventType: 'machine_offline',
          machineId: m.machineId,
        });
      }
    } catch (error) {
      console.error(`[cron/health-check] Failed to send alert for site ${plan.siteId}:`, error);
    }
  }

  return NextResponse.json({
    ok: true,
    sitesChecked,
    machinesChecked,
    offlineMachines,
    alertsSuppressed,
    alertsSent,
  });
}
