/**
 * Webhook-delivery billing gate (billing-system wave 2.6).
 *
 * The lockout matrix in `dev/active/billing-system/plan.md` says outbound
 * webhook delivery is **paused** — not queued, not retried, not recorded as a
 * failure — while an account is `expired` or `canceled`. This module is the
 * one place that answers "may this site's webhooks go out right now?".
 *
 * **Why a separate module from `billingSnapshot.server.ts`.** The snapshot
 * resolves state *and* tier, and its callers are request-scoped gates that
 * throw. Delivery is a fan-out in a background job: it needs a boolean, it
 * must never throw, and it needs to memoise across a batch. Wrapping the
 * snapshot would mean an extra `getSiteTier()` per site and an error posture
 * the gates deliberately don't have.
 *
 * **Deliberately state-only, never tier.** A `core` account is fully paid
 * up; webhooks are a pro feature, so a core site should never have had a
 * subscription to deliver for in the first place — that is *creation*'s job
 * (`POST /api/webhooks` is pro-gated) and downgrading an account must not
 * silently stop delivering to endpoints the customer can still see and
 * manage. This gate draws the same line wave 0.6 drew for the control plane:
 * lockout blocks, tier does not.
 *
 * **Fail open.** Any read failure delivers. Losing a customer's production
 * webhooks because a `customers/{uid}` read hiccuped is far worse than one
 * delivery to an account that had gone quiet — the same posture as
 * `getBillingSnapshot()` and the health-check alert cutoff.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import { isLockedOut, type LockedBillingState } from '@/lib/billing/billingSnapshot.server';

/**
 * Per-batch memo for {@link webhookDeliveryPausedBy}.
 *
 * Two levels because the two reads have different fan-in:
 *
 * - `siteOwners` collapses repeat calls for the **same site** — the offline
 *   cron fires one webhook per not-responding machine, so a site with 20
 *   dead machines would otherwise pay 20 site reads.
 * - `ownerStates` collapses across **different sites under one owner**, which
 *   is the multi-site case the account model exists for.
 *
 * Deliberately a caller-owned object rather than a module-level cache with a
 * TTL: the decision must be live, so a customer who converts mid-run has
 * delivery restored on the next batch with no redeploy and no cache to expire.
 * Callers with a single event per request pass nothing and read through.
 */
export interface WebhookBillingCache {
  /** siteId → owner uid (`null` = site has no owner, or does not exist). */
  readonly siteOwners: Map<string, string | null>;
  /** owner uid → the state that pauses delivery, or `null` to deliver. */
  readonly ownerStates: Map<string, LockedBillingState | null>;
}

/** A fresh memo. One per batch — never share one across runs. */
export function createWebhookBillingCache(): WebhookBillingCache {
  return { siteOwners: new Map(), ownerStates: new Map() };
}

export interface WebhookDeliveryGateOptions {
  /** Reuse the caller's Firestore handle; omit to resolve one. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
  /** Memo shared across a batch. Omit for one-off calls. */
  cache?: WebhookBillingCache;
}

/**
 * The billing state pausing this site's webhook delivery, or `null` when
 * delivery should proceed.
 *
 * Returns the state (rather than a bare boolean) so the caller can log *why*
 * without a second read — `expired` and `canceled` are different support
 * conversations.
 *
 * Costs at most one `sites/{siteId}` read plus one `customers/{uid}` read,
 * both memoised when a `cache` is supplied. A site with no `owner` field
 * (legacy or partially-written) has no billing customer and always delivers.
 */
export async function webhookDeliveryPausedBy(
  siteId: string,
  options: WebhookDeliveryGateOptions = {},
): Promise<LockedBillingState | null> {
  const { cache } = options;

  try {
    const db = options.db ?? getAdminDb();

    let ownerUid = cache?.siteOwners.get(siteId);
    if (ownerUid === undefined) {
      const siteSnap = await db.collection('sites').doc(siteId).get();
      const rawOwner = siteSnap.exists ? siteSnap.data()?.owner : undefined;
      ownerUid = typeof rawOwner === 'string' && rawOwner.length > 0 ? rawOwner : null;
      cache?.siteOwners.set(siteId, ownerUid);
    }
    if (ownerUid === null) return null;

    const cachedState = cache?.ownerStates.get(ownerUid);
    if (cachedState !== undefined) return cachedState;

    const customerSnap = await db.collection('customers').doc(ownerUid).get();
    const customer = customerSnap.exists
      ? (customerSnap.data() as BillingStateSource | undefined) ?? null
      : null;

    const state = resolveBillingState(customer, options.now);
    const pausedBy = isLockedOut(state) ? state : null;
    cache?.ownerStates.set(ownerUid, pausedBy);
    return pausedBy;
  } catch (error) {
    // Fail open — see the module header.
    console.error(
      `[webhooks] billing lookup failed for site ${siteId}; delivering anyway:`,
      error,
    );
    return null;
  }
}
