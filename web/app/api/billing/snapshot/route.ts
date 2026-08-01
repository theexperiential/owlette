// @auth-bypass: "actor IS target" — the caller reads their OWN billing.
// `authorizedPlatformHandler` requires superadmin (wrong: every account owner
// sees their own bill) and `authorizedSiteHandler` requires a siteId (wrong:
// billing is account-level, and an account may own no sites). Auth is
// enforced inline below; same model as the sibling portal route.
/**
 * GET /api/billing/snapshot — everything the billing tab renders
 *                             (billing-system wave 2.5).
 *
 * One round trip that answers "what am I on, what is it costing me, and what
 * can I do about it": the account's resolved billing state and trial clock,
 * every site it owns with that site's tier and active-machine count, the most
 * recent usage mirror, and the projected monthly bill built from them.
 *
 * ## Why a route and not a client listener
 *
 * The obvious shape — `onSnapshot('customers/{uid}')` from a hook — would need
 * `firestore.rules` to grant the client read access to `customers/*`,
 * `billing/*`, and a cross-site machine count. That is a permanent widening of
 * the client's read surface for one settings tab, and this codebase has been
 * bitten before by client listeners on owner-only collections
 * (`useUserManagement`'s users listener). Reading server-side with the admin
 * SDK keeps the rules exactly as they are, and lets the projection math run
 * once in a place the numbers can be tested.
 *
 * ## Auth model
 *
 * Session or freshly-issued ID token only (`requireSessionOrIdToken` with
 * `rejectAgentTokens`), never an api key — the same posture as the portal
 * route. The response names every site the account owns and what it pays; a
 * scraped CLI key must not be able to enumerate that.
 *
 * Owner-only falls out of the addressing rather than a role check: the customer
 * doc is `customers/{uid}` and the site query is
 * `sites where owner == uid`, both keyed on the *verified* caller uid, so there
 * is no parameter through which one account could read another's bill. A user
 * who is a member (not owner) of somebody else's site simply doesn't see it
 * here — that site is on its owner's invoice, not theirs. An account owning no
 * sites gets an empty-but-valid snapshot rather than a 404: "you have nothing
 * yet" is a state the tab renders, not an error.
 *
 * ## Fail-open, deliberately
 *
 * A missing `customers/{uid}` doc resolves to `'trialing'` via
 * `resolveBillingState()` — the documented pre-go-live posture for accounts
 * that predate customer minting. Nothing here 404s on absent billing data.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  ApiAuthError,
  assertActiveUser,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemTokenExpired,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { resolveBillingState, type BillingStateSource } from '@/lib/billing/billingState';
import { isMachineActive, projectAccountBill } from '@/lib/billing/pricing';
import { getSiteTier, type SiteTier } from '@/lib/siteTier';
import { isStripeConfigured } from '@/lib/stripe.server';
import type {
  BillingSnapshotResponse,
  BillingSnapshotSite,
  BillingSnapshotUsage,
  BillingSnapshotUsageSite,
} from '@/lib/types/billingSnapshot';
import type { BillingTimestamp } from '@/lib/types/customer';
import { withRateLimit } from '@/lib/withRateLimit';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Epoch ms from any timestamp shape a customers doc can carry, else `null`. */
function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const v = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === 'function') {
      try {
        const ms = v.toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return null;
}

/**
 * Whole days from `now` until `endsAtMs`, floored at 0.
 *
 * Rounded **up**, so the last partial day still reads "1 day left" rather than
 * "0 days left" while the account demonstrably still works. A countdown that
 * says zero before the lockout lands would make us look broken.
 */
function daysUntil(endsAtMs: number | null, now: Date): number | null {
  if (endsAtMs === null) return null;
  const remaining = endsAtMs - now.getTime();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / MS_PER_DAY);
}

/** A non-negative finite number, or `null`. */
function toCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/**
 * Normalise one row of the usage mirror's per-site data.
 *
 * Read tolerantly: the cron that writes these is landing alongside this route,
 * so the field spellings are not yet frozen. Anything unreadable degrades to
 * `null` (which renders as "no data") rather than throwing — a malformed usage
 * doc must never take the billing tab down.
 */
function normaliseUsageSite(siteId: string, raw: unknown): BillingSnapshotUsageSite {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    siteId,
    activeMachineCount:
      toCount(row.activeMachineCount) ??
      toCount(row.machineCount) ??
      toCount(row.machines),
    storageBytes: toCount(row.storageBytes) ?? toCount(row.storage) ?? toCount(row.bytes),
  };
}

/**
 * Normalise the whole usage mirror.
 *
 * Accepts `sites` as either an array of rows carrying their own `siteId` or a
 * map keyed by site id — both are natural ways to write this doc and the cron
 * has not committed to one. Returns `null` for a doc with neither.
 */
function normaliseUsage(period: string, data: Record<string, unknown>): BillingSnapshotUsage {
  const rawSites = data.sites ?? data.perSite;
  const sites: BillingSnapshotUsageSite[] = [];

  if (Array.isArray(rawSites)) {
    for (const entry of rawSites) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const siteId = typeof row.siteId === 'string' ? row.siteId : null;
      if (siteId) sites.push(normaliseUsageSite(siteId, row));
    }
  } else if (rawSites && typeof rawSites === 'object') {
    for (const [siteId, entry] of Object.entries(rawSites as Record<string, unknown>)) {
      sites.push(normaliseUsageSite(siteId, entry));
    }
  }

  const totals = (data.totals ?? {}) as Record<string, unknown>;
  return {
    period,
    sites,
    totals: {
      activeMachineCount:
        toCount(totals.activeMachineCount) ??
        toCount(totals.machineCount) ??
        toCount(totals.machines),
      storageBytes:
        toCount(totals.storageBytes) ?? toCount(totals.storage) ?? toCount(totals.bytes),
    },
  };
}

export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      await assertActiveUser(userId);

      const now = new Date();
      const db = getAdminDb();

      // The customer doc, the owned sites, and the latest usage mirror are
      // independent reads — issue them together rather than serially.
      // `billing/{uid}/usage` is ordered by document id because the ids are
      // `YYYY-MM-DD` period keys, which sort lexicographically as dates.
      const [customerSnap, sitesSnap, usageSnap] = await Promise.all([
        db.collection('customers').doc(userId).get(),
        db.collection('sites').where('owner', '==', userId).get(),
        db
          .collection('billing')
          .doc(userId)
          .collection('usage')
          .orderBy('__name__', 'desc')
          .limit(1)
          .get()
          // The cron that writes this hasn't shipped yet, and a missing
          // subcollection or index must not fail the whole tab.
          .catch(() => null),
      ]);

      const customer = customerSnap.exists
        ? ((customerSnap.data() as BillingStateSource & Record<string, unknown>) ?? null)
        : null;

      const billingState = resolveBillingState(customer, now);
      const trialEndsAt = toMillis(customer?.trialEndsAt as BillingTimestamp | null | undefined);
      const rawTier = customer?.subscriptionTier;
      const subscriptionTier: SiteTier | null =
        rawTier === 'core' || rawTier === 'pro' ? rawTier : null;
      const stripeCustomerId = customer?.stripeCustomerId;

      const usageDoc = usageSnap && !usageSnap.empty ? usageSnap.docs[0] : null;
      const usage = usageDoc ? normaliseUsage(usageDoc.id, usageDoc.data() ?? {}) : null;
      const storageBySite = new Map<string, number | null>(
        (usage?.sites ?? []).map((s) => [s.siteId, s.storageBytes]),
      );

      // Machine counts come from the live `machines` subcollections rather than
      // the usage mirror: the mirror is up to a day stale, and a customer who
      // just added a machine should see it in the projection immediately. The
      // mirror is authoritative only for storage, which the dashboard has no
      // other cheap way to total.
      const sites: BillingSnapshotSite[] = await Promise.all(
        sitesSnap.docs.map(async (siteDoc) => {
          const data = siteDoc.data() ?? {};
          const machinesSnap = await siteDoc.ref.collection('machines').get();
          const activeMachineCount = machinesSnap.docs.reduce(
            (count, machineDoc) =>
              isMachineActive(
                (machineDoc.data() ?? {}).lastHeartbeat as BillingTimestamp | null | undefined,
                now,
              )
                ? count + 1
                : count,
            0,
          );
          return {
            siteId: siteDoc.id,
            name: typeof data.name === 'string' && data.name.length > 0 ? data.name : siteDoc.id,
            tier: getSiteTier(data),
            activeMachineCount,
          };
        }),
      );

      sites.sort((a, b) => a.name.localeCompare(b.name));

      const projectedBill = projectAccountBill(
        sites.map((site) => ({
          siteId: site.siteId,
          tier: site.tier,
          activeMachineCount: site.activeMachineCount,
          storageBytes: storageBySite.get(site.siteId) ?? null,
        })),
      );

      const body: BillingSnapshotResponse = {
        billingState,
        trialEndsAt,
        daysLeft: billingState === 'trialing' ? daysUntil(trialEndsAt, now) : null,
        subscriptionTier,
        currentPeriodEnd: toMillis(customer?.currentPeriodEnd),
        stripeConfigured: isStripeConfigured(),
        hasBillingAccount: typeof stripeCustomerId === 'string' && stripeCustomerId.length > 0,
        sites,
        usage,
        projectedBill,
      };

      // Private and uncacheable: this is one account's billing position, and a
      // shared cache serving it to the next caller would be a data leak.
      return NextResponse.json(body, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) return problemUnauthorized(error.message);
        if (error.status === 403) return problemForbidden(error.message);
        return problem({
          type: ProblemType.Internal,
          title: 'authorization error',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'billing/snapshot:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
