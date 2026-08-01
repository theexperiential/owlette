/**
 * Superadmin billing aggregation (billing-system tasks 4.1 + 4.2).
 *
 * Two read-only surfaces the admin area renders:
 *
 *  - {@link listBillingCustomers} — every account with its resolved billing
 *    state, tier, comp provenance and trial clock, for the customers table.
 *  - {@link buildBillingOverview} — the ops dashboard: population counts, an
 *    MRR *projection*, trial conversion, and the roost storage leaderboard.
 *
 * Beside the routes rather than inside them so the aggregation is testable
 * against a Firestore fake with no request in play: everything takes an
 * injectable `db` and `now`.
 *
 * ## Scaling lever
 *
 * Both functions full-scan `customers` (and the overview additionally scans
 * `sites`, plus one `roost/quota` read per site and one usage-mirror read per
 * subscribed account). That is deliberate and appropriate at the fleet size
 * this ships to — a few hundred documents, read once when an admin opens the
 * page. It is also the first thing to change when it stops being: the lever is
 * a nightly rollup written to `billing/_ops/{YYYY-MM-DD}` by the same cron
 * that already walks every customer (`runTrialLifecycle`), with these
 * functions reading the rollup and only falling back to a live scan when it is
 * missing. Nothing else about the shape of the responses would need to move.
 *
 * ## Reads state, never writes it
 *
 * `billingState` is always recomputed here with `resolveBillingState()` rather
 * than read off the stored mirror, so an account whose cron sweep has not run
 * since it lapsed still shows as expired. The disagreement is surfaced
 * (`staleMirror`) rather than repaired — repairing is the sweep's job, and an
 * admin opening a dashboard must not silently mutate billing records.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  billingTimestampToMillis,
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import { isCompedTier, type BillingOverrideCustomer } from '@/lib/billing/billingOverride.server';
import { alertEmailsDisabled } from '@/lib/billing/trialLifecycle.server';
import { includedStorageBytes, projectAccountBill, roundUsd } from '@/lib/billing/pricing';
import { getSiteTier, type SiteTier } from '@/lib/siteTier';
import type { BillingState } from '@/lib/types/customer';
import type {
  AdminBillingCustomer,
  AdminBillingCustomerListResponse,
  AdminBillingOverviewResponse,
  AdminBillingStorageRow,
} from '@/lib/types/billingAdmin';

/** Rows the customers list will return at most, and its default. */
export const CUSTOMER_LIST_MAX_LIMIT = 500;
export const CUSTOMER_LIST_DEFAULT_LIMIT = 100;

/** Accounts on the storage leaderboard. */
export const STORAGE_TOP_LIMIT = 10;

/**
 * Fraction of the included allowance at which an account is flagged as
 * approaching overage — "within 10% of the threshold", per task 4.2.
 *
 * Accounts already *past* the allowance stay on the list rather than getting
 * their own: they are the same conversation for ops (call the customer before
 * the invoice does), and splitting them would let a site that tipped over
 * between two page loads vanish from the view an admin was watching.
 */
export const STORAGE_ALERT_FRACTION = 0.9;

/** Rows the approaching-overage list will return at most. */
export const STORAGE_ALERT_LIMIT = 25;

export interface BillingOpsOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
}

export interface ListBillingCustomersOptions extends BillingOpsOptions {
  /** Case-insensitive substring match against uid, email, and display name. */
  query?: string;
  /** Restrict to one resolved billing state. */
  state?: BillingState;
  /** Row cap; clamped to {@link CUSTOMER_LIST_MAX_LIMIT}. */
  limit?: number;
}

/** The `users/{uid}` fields these surfaces read. */
interface UserProfile {
  email: string | null;
  displayName: string | null;
  deleted: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTier(value: unknown): SiteTier | null {
  return value === 'core' || value === 'pro' ? value : null;
}

function readBillingState(value: unknown): BillingState | null {
  return value === 'trialing' || value === 'active' || value === 'expired' || value === 'canceled'
    ? value
    : null;
}

function toProfile(data: Record<string, unknown> | undefined): UserProfile {
  return {
    email: readString(data?.email),
    displayName: readString(data?.displayName) ?? readString(data?.name),
    // `userDeleteCascade.server.ts` soft-deletes by stamping a numeric
    // `deletedAt`; the same narrowing the auth layer uses.
    deleted: typeof data?.deletedAt === 'number',
  };
}

/** A non-negative finite number, or `0`. Used for both byte totals and counts. */
function toNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Project one customer doc into a table row.
 *
 * Exported for the route tests: the whole per-row decision set (state
 * resolution, comp detection, mirror staleness, alert mute) is pure given a
 * document and a clock.
 */
export function toAdminBillingCustomer(
  uid: string,
  raw: Record<string, unknown>,
  profile: UserProfile,
  now: Date,
): AdminBillingCustomer {
  const customer = raw as BillingOverrideCustomer;
  const billingState = resolveBillingState(customer as BillingStateSource, now);
  const storedMirror = readBillingState(raw.billingState);
  const comped = isCompedTier(customer);
  const subscriptionId = readString(raw.subscriptionId);

  return {
    uid,
    email: profile.email,
    displayName: profile.displayName,
    deleted: profile.deleted,
    billingState,
    staleMirror: storedMirror !== null && storedMirror !== billingState ? storedMirror : null,
    subscriptionStatus: readString(raw.subscriptionStatus),
    subscriptionTier: readTier(raw.subscriptionTier),
    comped,
    comp: comped
      ? {
          at: billingTimestampToMillis(customer.compedAt as NonNullable<typeof customer.compedAt>),
          by: readString(raw.compedBy),
          note: readString(raw.compNote),
        }
      : null,
    trialEndsAt: customer.trialEndsAt == null ? null : billingTimestampToMillis(customer.trialEndsAt),
    currentPeriodEnd:
      raw.currentPeriodEnd == null
        ? null
        : billingTimestampToMillis(raw.currentPeriodEnd as NonNullable<typeof customer.trialEndsAt>),
    hasSubscription: subscriptionId !== null,
    alertEmailsMuted: alertEmailsDisabled(customer, now),
  };
}

/**
 * Read every `users/{uid}` doc once, indexed by uid.
 *
 * One collection read rather than a per-customer `getAll`: the list has to
 * match the search term against email, so it needs the profile of *every*
 * account before it can filter, and N point reads to answer that would cost
 * strictly more than one scan.
 */
async function readUserProfiles(db: Firestore): Promise<Map<string, UserProfile>> {
  const snap = await db.collection('users').get();
  return new Map(snap.docs.map((doc) => [doc.id, toProfile(doc.data() ?? {})]));
}

/** Read a bounded set of `users/{uid}` docs for labelling. */
async function readUserProfilesFor(
  db: Firestore,
  uids: string[],
): Promise<Map<string, UserProfile>> {
  const entries = await Promise.all(
    uids.map(async (uid): Promise<[string, UserProfile]> => {
      const snap = await db.collection('users').doc(uid).get();
      return [uid, toProfile(snap.exists ? snap.data() ?? {} : {})];
    }),
  );
  return new Map(entries);
}

/**
 * List accounts for the admin customers table.
 *
 * Sorted by email (accounts with no user doc sort last, by uid) so the table
 * is stable across reloads — a list an admin is about to act on must not
 * reorder under them.
 */
export async function listBillingCustomers(
  options: ListBillingCustomersOptions = {},
): Promise<AdminBillingCustomerListResponse> {
  const db = options.db ?? getAdminDb();
  const now = options.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(options.limit ?? CUSTOMER_LIST_DEFAULT_LIMIT, CUSTOMER_LIST_MAX_LIMIT),
  );
  const needle = (options.query ?? '').trim().toLowerCase();

  const [customersSnap, profiles] = await Promise.all([
    db.collection('customers').get(),
    readUserProfiles(db),
  ]);

  const rows = customersSnap.docs.map((doc) =>
    toAdminBillingCustomer(
      doc.id,
      doc.data() ?? {},
      profiles.get(doc.id) ?? { email: null, displayName: null, deleted: false },
      now,
    ),
  );

  const matchedRows = rows.filter((row) => {
    if (options.state && row.billingState !== options.state) return false;
    if (!needle) return true;
    return (
      row.uid.toLowerCase().includes(needle) ||
      (row.email?.toLowerCase().includes(needle) ?? false) ||
      (row.displayName?.toLowerCase().includes(needle) ?? false)
    );
  });

  matchedRows.sort((a, b) => {
    if (a.email && b.email) return a.email.localeCompare(b.email) || a.uid.localeCompare(b.uid);
    if (a.email) return -1;
    if (b.email) return 1;
    return a.uid.localeCompare(b.uid);
  });

  return {
    customers: matchedRows.slice(0, limit),
    matched: matchedRows.length,
    total: rows.length,
    truncated: matchedRows.length > limit,
  };
}

/* ─── overview ─────────────────────────────────────────────────────────── */

/** Storage totals for one account, before it is labelled with an email. */
interface AccountStorage {
  siteCount: number;
  usedBytes: number;
  includedBytes: number;
  overageBytes: number;
}

/**
 * Sum roost storage per owning account.
 *
 * `usedBytes` counts every site the account owns, including `core` sites: roost
 * is pro-only, so bytes on a core site are pre-downgrade leftovers, and hiding
 * them would understate what the account is actually costing us to store.
 * `includedBytes` and `overageBytes` are pro-only, matching
 * `projectSiteBill()` — a core site has no allowance to be over.
 *
 * A site's `planLimitBytes` (a one-off grant) wins over the tier constant,
 * exactly as `usageReport.server.ts` resolves it, so a granted account is not
 * flagged for an overage it does not have.
 */
async function readStorageByOwner(db: Firestore): Promise<Map<string, AccountStorage>> {
  const sitesSnap = await db.collection('sites').get();

  const perSite = await Promise.all(
    sitesSnap.docs.map(async (siteDoc) => {
      const data = siteDoc.data() ?? {};
      const owner = readString(data.owner);
      const tier = getSiteTier(data);
      const quotaSnap = await siteDoc.ref
        .collection('roost')
        .doc('quota')
        .get()
        // Most sites legitimately have no quota doc yet (the reconcile job
        // that populates `usedBytes` is not wired up), and one unreadable
        // quota must never take the whole dashboard down.
        .catch(() => null);
      const quota = quotaSnap?.exists ? quotaSnap.data() ?? {} : {};

      const usedBytes = toNonNegative(quota.usedBytes);
      const limitBytes =
        typeof quota.planLimitBytes === 'number' && Number.isFinite(quota.planLimitBytes)
          ? Math.max(0, quota.planLimitBytes)
          : includedStorageBytes(tier);

      return {
        owner,
        tier,
        usedBytes,
        includedBytes: tier === 'pro' ? limitBytes : 0,
        overageBytes: tier === 'pro' ? Math.max(0, usedBytes - limitBytes) : 0,
      };
    }),
  );

  const byOwner = new Map<string, AccountStorage>();
  for (const site of perSite) {
    if (!site.owner) continue;
    const acc = byOwner.get(site.owner) ?? {
      siteCount: 0,
      usedBytes: 0,
      includedBytes: 0,
      overageBytes: 0,
    };
    acc.siteCount += 1;
    acc.usedBytes += site.usedBytes;
    acc.includedBytes += site.includedBytes;
    acc.overageBytes += site.overageBytes;
    byOwner.set(site.owner, acc);
  }
  return byOwner;
}

/** The most recent `billing/{uid}/usage/{YYYY-MM-DD}` mirror, or `null`. */
async function readLatestUsage(
  db: Firestore,
  uid: string,
): Promise<{ period: string; data: Record<string, unknown> } | null> {
  const snap = await db
    .collection('billing')
    .doc(uid)
    .collection('usage')
    // Document ids are `YYYY-MM-DD` period keys, which sort lexicographically
    // as dates — the same ordering the customer-facing snapshot route uses.
    .orderBy('__name__', 'desc')
    .limit(1)
    .get()
    .catch(() => null);
  if (!snap || snap.empty) return null;
  const doc = snap.docs[0];
  return { period: doc.id, data: (doc.data() ?? {}) as Record<string, unknown> };
}

/**
 * Turn one usage mirror into the projection inputs `pricing.ts` expects.
 *
 * The mirror's per-site rows carry `activeMachines` and `storageUsedBytes`
 * (see `SiteUsage` in `usageReport.server.ts`); `projectSiteBill()` re-derives
 * the 3-machine floor and the overage from them, so the projection and the
 * metered quantities cannot drift apart by construction.
 */
function usageToBillInputs(data: Record<string, unknown>) {
  const sites = Array.isArray(data.sites) ? data.sites : [];
  return sites
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((row) => typeof row.siteId === 'string' && row.siteId.length > 0)
    .map((row) => ({
      siteId: row.siteId as string,
      tier: readTier(row.tier),
      activeMachineCount: toNonNegative(row.activeMachines),
      storageBytes: toNonNegative(row.storageUsedBytes),
    }));
}

/**
 * Build the ops dashboard.
 *
 * The MRR figure is a **projection**, not billed revenue: it re-runs
 * `projectAccountBill()` over each subscribed account's latest usage mirror at
 * list price. Stripe remains authoritative for what is actually charged, and
 * `mrr.withUsage` reports how many of the counted accounts had a mirror to
 * project from — when it is below `mrr.accounts`, the number is a floor.
 */
export async function buildBillingOverview(
  options: BillingOpsOptions = {},
): Promise<AdminBillingOverviewResponse> {
  const db = options.db ?? getAdminDb();
  const now = options.now ?? new Date();

  const [customersSnap, storageByOwner] = await Promise.all([
    db.collection('customers').get(),
    readStorageByOwner(db),
  ]);

  const byState: Record<BillingState, number> = {
    trialing: 0,
    active: 0,
    expired: 0,
    canceled: 0,
  };
  const byTier = { core: 0, pro: 0, none: 0 };
  let comped = 0;
  let converted = 0;
  let expired = 0;
  const subscribedUids: string[] = [];

  for (const doc of customersSnap.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>;
    const customer = raw as BillingOverrideCustomer;
    const state = resolveBillingState(customer as BillingStateSource, now);
    byState[state] += 1;

    const tier = readTier(raw.subscriptionTier);
    if (tier === 'core') byTier.core += 1;
    else if (tier === 'pro') byTier.pro += 1;
    else byTier.none += 1;

    if (isCompedTier(customer)) comped += 1;

    if (state === 'active') {
      subscribedUids.push(doc.id);
      // "Converted" means a trial that turned into a subscription. An account
      // with no clock on file (`trialEndsAt === null`, the pre-go-live
      // sentinel) never ran one — counting it would inflate the rate with
      // accounts that were subscribed before the trial model existed.
      if (customer.trialEndsAt != null) converted += 1;
    } else if (state === 'expired') {
      expired += 1;
    }
  }

  const usageDocs = await Promise.all(
    subscribedUids.map(async (uid) => ({ uid, usage: await readLatestUsage(db, uid) })),
  );

  let projectedUsd = 0;
  let withUsage = 0;
  let latestPeriod: string | null = null;
  for (const { usage } of usageDocs) {
    if (!usage) continue;
    withUsage += 1;
    if (latestPeriod === null || usage.period > latestPeriod) latestPeriod = usage.period;
    projectedUsd += projectAccountBill(usageToBillInputs(usage.data)).totalUsd;
  }

  const storageRows = [...storageByOwner.entries()]
    .map(([uid, acc]) => ({
      uid,
      siteCount: acc.siteCount,
      usedBytes: acc.usedBytes,
      includedBytes: acc.includedBytes,
      usedFraction: acc.includedBytes > 0 ? acc.usedBytes / acc.includedBytes : null,
      overageBytes: acc.overageBytes,
    }))
    .sort((a, b) => b.usedBytes - a.usedBytes || a.uid.localeCompare(b.uid));

  const topAccounts = storageRows.filter((row) => row.usedBytes > 0).slice(0, STORAGE_TOP_LIMIT);
  const approaching = storageRows
    .filter((row) => row.usedFraction !== null && row.usedFraction >= STORAGE_ALERT_FRACTION)
    .slice(0, STORAGE_ALERT_LIMIT);

  const labelUids = [...new Set([...topAccounts, ...approaching].map((row) => row.uid))];
  const profiles = await readUserProfilesFor(db, labelUids);
  const label = (row: Omit<AdminBillingStorageRow, 'email'>): AdminBillingStorageRow => ({
    ...row,
    email: profiles.get(row.uid)?.email ?? null,
  });

  const conversionDenominator = converted + expired;

  return {
    generatedAt: now.getTime(),
    customers: { total: customersSnap.docs.length, byState, byTier, comped },
    mrr: {
      projectedUsd: roundUsd(projectedUsd),
      accounts: subscribedUids.length,
      withUsage,
      latestPeriod,
    },
    conversion: {
      converted,
      expired,
      rate: conversionDenominator > 0 ? converted / conversionDenominator : null,
    },
    storage: {
      alertThreshold: STORAGE_ALERT_FRACTION,
      topAccounts: topAccounts.map(label),
      approachingOverage: approaching.map(label),
    },
  };
}
