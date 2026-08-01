/**
 * Metered usage reporting to Stripe (billing-system waves 2.3 + 2.4).
 *
 * Walks every account with a live subscription, counts the machines it is
 * billable for, measures its roost storage overage, and reports both to
 * Stripe. Runs once a day behind `/api/cron/billing-usage-report`.
 *
 * ## Billing Meters, not usage records
 *
 * Stripe's legacy metered API (`POST /v1/subscription_items/{id}/usage_records`,
 * surfaced as `subscriptionItems.createUsageRecord`) **does not exist in
 * `stripe@22.4.0`** — the resource was removed from the SDK, not merely
 * deprecated, so there is no version of this file that could have used it.
 * The current model is Billing Meters: usage is posted as *meter events*
 * naming a meter by `event_name`, and Stripe maps the event to a customer
 * through the payload and to a price through whichever subscription item is
 * backed by that meter.
 *
 * Two consequences shape everything below:
 *
 *  1. **We never name a price here.** `STRIPE_PRICE_*` stay checkout's
 *     business (task 2.1); this module only names meters. A price and a
 *     meter are wired together once, in the Stripe dashboard.
 *  2. **Meter events are append-only observations, not assignments.** The
 *     meter's own `default_aggregation.formula` decides how a period's
 *     events become an invoice quantity. These meters MUST be created with
 *     `formula: 'last'` — every value we send is a *snapshot* of the current
 *     count, so a `sum` meter would bill the customer roughly 30× (once per
 *     daily run). See {@link MACHINE_METER_EVENT_NAMES} for the full setup
 *     contract that task 1.1 has to satisfy.
 *
 * ## One meter per price, not one per concept
 *
 * There are three meters because there are three prices. Core and pro
 * machines bill at different rates ($10 vs $50), so they cannot share a
 * meter: a single "machines" meter feeding both prices would charge an
 * account holding one core and one pro site for its machines twice, at both
 * rates. The meter set mirrors `scripts/env-manifest.json`'s price set 1:1.
 *
 * ## Reporting zero is meaningful
 *
 * Every eligible account reports all three meters every day, including the
 * ones that resolve to `0`. Under `last` aggregation a value is an
 * overwrite, so skipping "nothing to report" would leave yesterday's nonzero
 * value standing as the period's answer — an account that deleted a terabyte
 * or decommissioned its fleet would keep paying for it until the period
 * rolled over.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';
import { getAdminDb } from '@/lib/firebase-admin';
import { getStripeOrNull, stripeMode } from '@/lib/stripe.server';
import { resolveBillingState, type BillingStateSource } from '@/lib/billing/billingState';
import { getSiteTier, TIER_STORAGE_BYTES, type SiteTier } from '@/lib/siteTier';
import logger from '@/lib/logger';

/**
 * Meter `event_name` per site tier — the machine-count meters.
 *
 * **Task 1.1 setup contract.** Each of these needs a Billing Meter created
 * in BOTH Stripe modes with exactly this `event_name`, and the matching
 * `STRIPE_PRICE_*_MACHINE` price pointed at it. Every meter here must use:
 *
 *   - `default_aggregation.formula: 'last'` — we send snapshots, not deltas.
 *   - `customer_mapping.event_payload_key: 'stripe_customer_id'` (the default).
 *   - `value_settings.event_payload_key: 'value'` (the default).
 *
 * `event_name` is single-use across an account's meters (Stripe rejects a
 * second meter claiming a name), which is what makes these constants a safe
 * routing key rather than a label.
 */
export const MACHINE_METER_EVENT_NAMES: Record<SiteTier, string> = {
  core: 'owlette_core_machines',
  pro: 'owlette_pro_machines',
};

/**
 * Meter `event_name` for roost storage overage, in whole GiB past the
 * included allowance. Same setup contract as
 * {@link MACHINE_METER_EVENT_NAMES}; pairs with
 * `STRIPE_PRICE_PRO_STORAGE_OVERAGE`.
 */
export const STORAGE_OVERAGE_METER_EVENT_NAME = 'owlette_roost_storage_overage_gb';

/**
 * How recently a machine must have checked in to be billable, in days.
 *
 * The boundary is exclusive: a heartbeat exactly this old does NOT count.
 * Same posture as `resolveBillingState()`'s trial clock, where landing
 * exactly on the boundary resolves to the expired side — a fleet that went
 * dark a week ago should stop being billed on the day it hits a week, not
 * the day after.
 */
export const ACTIVE_MACHINE_WINDOW_DAYS = 7;

const ACTIVE_MACHINE_WINDOW_MS = ACTIVE_MACHINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Machines a pro site is billed for regardless of how few it runs — the
 * marketing page's "3-machine minimum".
 *
 * A billing floor, not a gate: a pro site running one machine pays for three
 * and keeps running one. Core has no equivalent and bills its raw count.
 */
export const PRO_MINIMUM_MACHINES = 3;

/** Bytes per GiB. Overage is quoted in GiB, matching `TIER_STORAGE_BYTES`. */
export const BYTES_PER_GIB = 1024 ** 3;

/** Ledger keys for the three meters, stable across runs. */
type MeterKey = 'coreMachines' | 'proMachines' | 'storageOverageGb';

/** Per-site line of the daily usage mirror. */
export interface SiteUsage {
  siteId: string;
  tier: SiteTier;
  /** Machines with a heartbeat inside the window. */
  activeMachines: number;
  /** What the account is billed for — `max(3, active)` on pro, `active` on core. */
  billedMachines: number;
  /** Roost bytes in use, from the site's quota doc. `0` when unmeasured. */
  storageUsedBytes: number;
  /** The site's included allowance, honouring a one-off grant if present. */
  storageLimitBytes: number;
  /** Exact bytes past the allowance. Billed GiB is derived at the account level. */
  storageOverageBytes: number;
}

/** Everything reported for one account on one day. */
export interface CustomerUsage {
  uid: string;
  period: string;
  stripeCustomerId: string;
  subscriptionId: string;
  sites: SiteUsage[];
  totals: {
    sites: number;
    activeMachines: number;
    /** Billed machine count across the account's core sites. */
    coreMachines: number;
    /** Billed machine count across the account's pro sites. */
    proMachines: number;
    /** Exact overage bytes summed across sites. */
    storageOverageBytes: number;
    /** Whole GiB actually reported to Stripe. */
    storageOverageGb: number;
  };
}

/** What a run did, as returned by the cron route. */
export interface UsageReportSummary {
  ok: true;
  /** Present only when the run did nothing because Stripe has no key. */
  skipped?: 'unconfigured';
  /** UTC day the run reported for, `YYYY-MM-DD`. */
  period: string;
  /** Live or test Stripe account; `'unconfigured'` on a skipped run. */
  mode: string;
  customers: {
    /** Docs returned by the candidate query. */
    scanned: number;
    /** Accounts that passed the eligibility re-check and were processed. */
    eligible: number;
    /** Accounts that failed and will be retried by the next run. */
    failed: number;
  };
  meterEvents: {
    /** Events actually posted to Stripe. */
    sent: number;
    /** Events skipped because this period was already reported. */
    alreadyReported: number;
  };
  totals: {
    activeMachines: number;
    coreMachines: number;
    proMachines: number;
    storageOverageGb: number;
  };
  /** One entry per failed account. Never carries anything secret. */
  failures: Array<{ uid: string; error: string }>;
}

export interface UsageReportOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
}

/**
 * The UTC day a run reports for, `YYYY-MM-DD`.
 *
 * UTC rather than local time because the cron fires at 03:00 UTC and the
 * period doubles as the mirror doc id — a locale-dependent id would give the
 * same run two different names on two different hosts and break the
 * rerun-safety check outright.
 */
export function formatUsagePeriod(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Epoch millis from any shape a Firestore timestamp field arrives in, or `0`
 * when the value can't be read as a time.
 *
 * Deliberately permissive — the agent writes `lastHeartbeat` as a server
 * `Timestamp`, but a seven-day window reaches docs old enough to predate
 * that, and a value we fail to parse silently drops a machine from the bill.
 * A local copy rather than an import: the equivalent helper in
 * `healthChecks.server.ts` is private to a module that pulls in fetch
 * plumbing and base-url resolution, none of which belongs on a cron path.
 */
function millisFromValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    const ts = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
    };
    try {
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    } catch {
      return 0;
    }
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  }
  return 0;
}

/**
 * Machines the account is billed for at this tier.
 *
 * Pure, and the only place the 3-machine minimum is encoded. Core bills what
 * it runs; pro never bills below {@link PRO_MINIMUM_MACHINES}.
 *
 * The floor applies to a pro site running **zero** machines too. That is the
 * documented model — the minimum is what a pro *site* costs, not a discount
 * for switching everything off — and it is why sites are only counted for
 * accounts that hold a live subscription.
 */
export function billedMachinesFor(tier: SiteTier, activeMachines: number): number {
  const active = Math.max(0, Math.trunc(activeMachines));
  return tier === 'pro' ? Math.max(PRO_MINIMUM_MACHINES, active) : active;
}

/**
 * Exact bytes a site is over its included storage.
 *
 * Kept in bytes rather than GiB so the account total can be summed at full
 * precision and rounded exactly once — flooring per site and then summing
 * would discard up to a GiB of billable overage per site.
 *
 * **Core sites never accrue overage.** Roost is a pro feature and the
 * overage price is `STRIPE_PRICE_PRO_STORAGE_OVERAGE`, so a core site's
 * inclusion is zero (`TIER_STORAGE_BYTES.core`) and a naive subtraction
 * would report its entire footprint as overage — billing a core customer at
 * the pro rate for bytes their tier can't even reach. A core site holding
 * roost data left over from a downgrade is an upload-admission question,
 * which `quotaLogic.admitUpload` already answers with `tier_insufficient`;
 * it is not an invoice line.
 */
export function storageOverageBytesFor(
  tier: SiteTier,
  usedBytes: number,
  limitBytes: number,
): number {
  if (tier !== 'pro') return 0;
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes)) return 0;
  return Math.max(0, usedBytes - limitBytes);
}

/**
 * Whole GiB of overage to bill for, from an exact byte total.
 *
 * Floored, so a partial GiB is never charged. Two reasons: it keeps the
 * value an integer (Stripe's v2 meter API requires one, and pinning to
 * integers now means the v1→v2 move is not a repricing), and it puts the
 * rounding error on the customer's side of the line — a site three megabytes
 * past a terabyte owes nothing rather than five cents. The exact byte figure
 * is preserved in the mirror doc, so the billing tab can still show true
 * usage.
 */
export function storageOverageGbFor(overageBytes: number): number {
  if (!Number.isFinite(overageBytes) || overageBytes <= 0) return 0;
  return Math.floor(overageBytes / BYTES_PER_GIB);
}

/**
 * The deterministic dedupe key for one account's meter event on one day.
 *
 * Stripe dedupes meter events on `(event_name, identifier)` over a rolling
 * window of at least 24 hours and silently drops the repeat, so a same-day
 * rerun that gets past our own ledger still cannot double-report. Stripe's
 * guidance is explicit that this — not the HTTP `Idempotency-Key` header —
 * is the deduplication mechanism for meter events, which is why no
 * `idempotencyKey` request option is set at the call site.
 *
 * Bounded well inside Stripe's 100-character limit: the longest event name
 * is 32 characters, a uid is 28, and the period is 10.
 */
export function usageEventIdentifier(
  eventName: string,
  uid: string,
  period: string,
): string {
  return `${eventName}-${uid}-${period}`;
}

/** A meter event this run intends to post. */
interface PendingMeterEvent {
  key: MeterKey;
  eventName: string;
  value: number;
}

/** What the mirror doc records about an event we successfully posted. */
interface ReportedMeterEvent {
  eventName: string;
  identifier: string;
  value: number;
  reportedAt: Date;
}

/**
 * Read a site's roost quota.
 *
 * Mirrors `GET /api/sites/{siteId}/quota`'s narrowing with one deliberate
 * divergence: the tier comes from the **site doc**, not the quota doc.
 * `quotaEnforce.ts` documents its copy of `tier` as a stale cache, and the
 * site doc is what every other gate bills and gates from — reading the cache
 * here could bill a site at a tier it no longer holds.
 *
 * `planLimitBytes` from the doc still wins over the tier constant when it is
 * present, because that is how a one-off storage grant is expressed.
 *
 * A missing doc is not an error. Roost's reconcile job cannot populate
 * `usedBytes` until the R2 metrics wiring lands, so most sites legitimately
 * have no quota doc today; they measure as zero used and therefore zero
 * overage.
 */
async function readSiteStorage(
  siteRef: FirebaseFirestore.DocumentReference,
  tier: SiteTier,
): Promise<{ usedBytes: number; limitBytes: number }> {
  const quotaSnap = await siteRef.collection('roost').doc('quota').get();
  const data = quotaSnap.exists ? quotaSnap.data() ?? {} : {};

  const usedBytes = typeof data.usedBytes === 'number' && Number.isFinite(data.usedBytes)
    ? Math.max(0, data.usedBytes)
    : 0;
  const limitBytes = typeof data.planLimitBytes === 'number' && Number.isFinite(data.planLimitBytes)
    ? Math.max(0, data.planLimitBytes)
    : TIER_STORAGE_BYTES[tier];

  return { usedBytes, limitBytes };
}

/**
 * Count the machines under a site that checked in inside the window.
 *
 * Reads the whole `machines` subcollection and filters in memory rather than
 * issuing `where('lastHeartbeat', '>=', cutoff)`. A range query would skip
 * every doc whose `lastHeartbeat` is missing or stored as something other
 * than a `Timestamp`, and "skip" here means "silently stop billing for that
 * machine" — the wrong direction to fail. The scan is bounded to sites owned
 * by subscribed accounts, and the health-check cron already reads the same
 * subcollections whole.
 *
 * `online` is deliberately ignored. It is a 3-minute liveness flag: a
 * machine that shut down gracefully yesterday carries `online: false` with a
 * fresh heartbeat, and one that crashed carries `online: true` frozen
 * forever. Neither says anything about a seven-day window.
 */
async function countActiveMachines(
  siteRef: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
): Promise<number> {
  const machinesSnap = await siteRef.collection('machines').get();
  let active = 0;
  for (const machineDoc of machinesSnap.docs) {
    const heartbeatMs = millisFromValue(machineDoc.data()?.lastHeartbeat);
    if (heartbeatMs > cutoffMs) active += 1;
  }
  return active;
}

/** Measure one account's sites. Throws; the per-account boundary catches. */
async function measureCustomer(
  db: Firestore,
  uid: string,
  period: string,
  stripeCustomerId: string,
  subscriptionId: string,
  cutoffMs: number,
): Promise<CustomerUsage> {
  const sitesSnap = await db.collection('sites').where('owner', '==', uid).get();

  const sites = await Promise.all(
    sitesSnap.docs.map(async (siteDoc): Promise<SiteUsage> => {
      const tier = getSiteTier(siteDoc.data());
      const [activeMachines, storage] = await Promise.all([
        countActiveMachines(siteDoc.ref, cutoffMs),
        readSiteStorage(siteDoc.ref, tier),
      ]);

      return {
        siteId: siteDoc.id,
        tier,
        activeMachines,
        billedMachines: billedMachinesFor(tier, activeMachines),
        storageUsedBytes: storage.usedBytes,
        storageLimitBytes: storage.limitBytes,
        storageOverageBytes: storageOverageBytesFor(tier, storage.usedBytes, storage.limitBytes),
      };
    }),
  );

  const totals = sites.reduce(
    (acc, site) => {
      acc.activeMachines += site.activeMachines;
      if (site.tier === 'pro') acc.proMachines += site.billedMachines;
      else acc.coreMachines += site.billedMachines;
      acc.storageOverageBytes += site.storageOverageBytes;
      return acc;
    },
    {
      sites: sites.length,
      activeMachines: 0,
      coreMachines: 0,
      proMachines: 0,
      storageOverageBytes: 0,
      storageOverageGb: 0,
    },
  );
  totals.storageOverageGb = storageOverageGbFor(totals.storageOverageBytes);

  return { uid, period, stripeCustomerId, subscriptionId, sites, totals };
}

/**
 * The full set of meter events one account owes for a period, before any
 * dedupe. Always all three — see the module header on why a zero is worth
 * sending.
 */
function allMeterEvents(usage: CustomerUsage): PendingMeterEvent[] {
  return [
    {
      key: 'coreMachines',
      eventName: MACHINE_METER_EVENT_NAMES.core,
      value: usage.totals.coreMachines,
    },
    {
      key: 'proMachines',
      eventName: MACHINE_METER_EVENT_NAMES.pro,
      value: usage.totals.proMachines,
    },
    {
      key: 'storageOverageGb',
      eventName: STORAGE_OVERAGE_METER_EVENT_NAME,
      value: usage.totals.storageOverageGb,
    },
  ];
}

/**
 * Post one account's outstanding meter events and mirror the result.
 *
 * Returns how many events went to Stripe. Throws on the first Stripe or
 * Firestore failure — the caller records the account as failed and moves on,
 * so one broken account cannot cost the rest of the fleet its billing day.
 */
async function reportCustomer(
  db: Firestore,
  stripe: Stripe,
  usage: CustomerUsage,
  now: Date,
): Promise<{ sent: number; alreadyReported: number }> {
  const usageRef = db
    .collection('billing')
    .doc(usage.uid)
    .collection('usage')
    .doc(usage.period);

  const existingSnap = await usageRef.get();
  const existing = existingSnap.exists ? existingSnap.data() ?? {} : {};
  const existingEvents = (existing.meterEvents ?? {}) as Record<string, unknown>;

  // The ledger: an entry under `meterEvents.{key}` means that meter was
  // posted successfully for this period, so a rerun skips the call entirely
  // rather than relying on Stripe to absorb it.
  //
  // The ledger is written *after* Stripe accepts, never before. Crashing in
  // between therefore leaves a reported-but-unrecorded meter, and the next
  // run re-posts it — which is safe precisely because
  // {@link usageEventIdentifier} is deterministic and Stripe drops the
  // repeat. The two mechanisms cover each other's gap; neither is redundant.
  const all = allMeterEvents(usage);
  const pending = all.filter((event) => !existingEvents[event.key]);
  const reported: Record<string, ReportedMeterEvent> = {};
  const timestamp = Math.floor(now.getTime() / 1000);

  for (const event of pending) {
    const identifier = usageEventIdentifier(event.eventName, usage.uid, usage.period);
    await stripe.billing.meterEvents.create({
      event_name: event.eventName,
      // Stripe types the payload as a string map — a numeric value here is
      // rejected by the SDK's own typing, not just the API.
      payload: {
        stripe_customer_id: usage.stripeCustomerId,
        value: String(event.value),
      },
      identifier,
      timestamp,
    });
    reported[event.key] = {
      eventName: event.eventName,
      identifier,
      value: event.value,
      reportedAt: now,
    };
  }

  // Mirrored whether or not anything was sent, so the billing tab sees a
  // current breakdown even on a rerun that had nothing left to report.
  await usageRef.set(
    {
      uid: usage.uid,
      period: usage.period,
      stripeCustomerId: usage.stripeCustomerId,
      subscriptionId: usage.subscriptionId,
      sites: usage.sites,
      totals: usage.totals,
      // Merged in code, then written whole. `set(..., { merge: true })`
      // treats an empty map as a leaf and would overwrite rather than merge
      // it, so a rerun with nothing left to send (`reported === {}`) would
      // erase the very ledger that made it a no-op.
      meterEvents: { ...existingEvents, ...reported },
      updatedAt: now,
    },
    { merge: true },
  );

  return { sent: pending.length, alreadyReported: all.length - pending.length };
}

/**
 * Report a day of usage for every account with a live subscription.
 *
 * Candidates come from `customers where billingState == 'active'` — the
 * cached mirror, used only to narrow the scan — and every candidate is then
 * re-checked with `resolveBillingState()`, which is authoritative. The cache
 * can only ever cost us a customer we should have billed (a run misses
 * them, the next one catches up); it can never bill someone who isn't
 * subscribed.
 *
 * `past_due` accounts resolve `'active'` and are reported deliberately: they
 * keep full service through Stripe's dunning window, and omitting their
 * usage would under-bill the invoice that dunning is trying to collect.
 *
 * Never throws for a single bad account. An unconfigured Stripe is a clean
 * no-op, not a failure — the whole pre-go-live window runs without a key.
 */
export async function runUsageReport(
  options: UsageReportOptions = {},
): Promise<UsageReportSummary> {
  const now = options.now ?? new Date();
  const period = formatUsagePeriod(now);
  const mode = stripeMode();

  const summary: UsageReportSummary = {
    ok: true,
    period,
    mode,
    customers: { scanned: 0, eligible: 0, failed: 0 },
    meterEvents: { sent: 0, alreadyReported: 0 },
    totals: { activeMachines: 0, coreMachines: 0, proMachines: 0, storageOverageGb: 0 },
    failures: [],
  };

  const stripe = getStripeOrNull();
  if (!stripe) {
    // The normal state until the Stripe account is provisioned (task 1.1).
    logger.debug('stripe not configured — skipping usage report', {
      context: 'usageReport',
      data: { period },
    });
    return { ...summary, skipped: 'unconfigured' };
  }

  const db = options.db ?? getAdminDb();
  const cutoffMs = now.getTime() - ACTIVE_MACHINE_WINDOW_MS;

  const candidates = await db
    .collection('customers')
    .where('billingState', '==', 'active')
    .get();

  summary.customers.scanned = candidates.size;

  for (const doc of candidates.docs) {
    const data = (doc.data() ?? {}) as BillingStateSource & {
      stripeCustomerId?: unknown;
      subscriptionId?: unknown;
    };

    const stripeCustomerId =
      typeof data.stripeCustomerId === 'string' && data.stripeCustomerId.length > 0
        ? data.stripeCustomerId
        : null;
    const subscriptionId =
      typeof data.subscriptionId === 'string' && data.subscriptionId.length > 0
        ? data.subscriptionId
        : null;

    // A live subscription needs all three: the authoritative state, the
    // subscription it resolves from, and a customer to attribute usage to.
    if (
      resolveBillingState(data, now) !== 'active' ||
      !stripeCustomerId ||
      !subscriptionId
    ) {
      continue;
    }

    summary.customers.eligible += 1;

    try {
      const usage = await measureCustomer(
        db,
        doc.id,
        period,
        stripeCustomerId,
        subscriptionId,
        cutoffMs,
      );
      const result = await reportCustomer(db, stripe, usage, now);

      summary.meterEvents.sent += result.sent;
      summary.meterEvents.alreadyReported += result.alreadyReported;
      summary.totals.activeMachines += usage.totals.activeMachines;
      summary.totals.coreMachines += usage.totals.coreMachines;
      summary.totals.proMachines += usage.totals.proMachines;
      summary.totals.storageOverageGb += usage.totals.storageOverageGb;
    } catch (err) {
      summary.customers.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push({ uid: doc.id, error: message });
      logger.error('usage report failed for account', {
        context: 'usageReport',
        data: { uid: doc.id, period, mode, error: message },
      });
    }
  }

  logger.info('usage report complete', {
    context: 'usageReport',
    data: {
      period,
      mode,
      eligible: summary.customers.eligible,
      failed: summary.customers.failed,
      sent: summary.meterEvents.sent,
    },
  });

  return summary;
}
