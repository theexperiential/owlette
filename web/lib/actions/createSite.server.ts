/**
 * createSite action core (security-boundary-migration wave 3.9 - site CRUD).
 *
 * Replaces the client-side `setDoc` in `web/hooks/useFirestore.ts:createSite`.
 * The action validates the requested site id (`web/lib/validators.ts`),
 * refuses to overwrite an existing site, and writes the site doc with the
 * caller as `owner`.
 *
 * The legacy hook only wrote the top-level `sites/{siteId}` document. It did
 * not add the site to `users/{uid}.sites[]`; ownership is the access path for
 * the creator. This core preserves that narrow behavior.
 *
 * Capability: `SITE_MEMBER_MANAGE` via the platform route wrapper. Site
 * creation has no existing site id to authorize against, so the route is
 * treated as a platform-level mutation.
 *
 * billing-system wave 0.3: the site's `tier` is derived from the owner's
 * billing state (`customers/{ownerUid}`) rather than a flat beta constant —
 * see `deriveSiteTier` below.
 *
 * billing-system wave 2.7: a core subscriber's one-site limit is enforced
 * here — see `coreSiteLimitReached` below.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { validateSiteId } from '@/lib/validators';
import { type SiteTier } from '@/lib/siteTier';
import {
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import type { BillingState } from '@/lib/types/customer';

const NAME_MAX_LENGTH = 200;

/**
 * The fields of a `customers/{uid}` doc this action reads. Firestore data is
 * untyped, so `subscriptionTier` arrives as `unknown` and is narrowed below
 * rather than trusted.
 */
type CustomerDocLike = BillingStateSource & { subscriptionTier?: unknown };

/**
 * Tier a new site is minted at when the account has no explicit entitlement
 * to read — a trialing account (the trial runs at the pro feature level), or
 * a subscribed account whose `subscriptionTier` hasn't been written yet.
 *
 * Deliberately a local constant rather than `siteTier.BETA_DEFAULT_TIER`:
 * that one is the *read-path* fallback for unstamped site docs and gets
 * deleted at go-live (task 5.3). This one encodes the write-path billing
 * posture and outlives it, so the two must not share a symbol — otherwise
 * 5.3's cleanup would silently change what new sites are minted as.
 */
const UNENTITLED_DEFAULT_TIER: SiteTier = 'pro';

/** Narrow the untyped `subscriptionTier` field off a customers doc. */
function parseSubscriptionTier(raw: unknown): SiteTier | null {
  return raw === 'core' || raw === 'pro' ? raw : null;
}

/**
 * Derive the tier a new site should be created at from its owner's billing
 * state (billing-system wave 0.3). Replaces the flat `BETA_DEFAULT_TIER`
 * write so a core subscriber's sites are minted as core the moment billing
 * goes live, without a second migration pass.
 *
 * | billing state          | tier                                |
 * |------------------------|-------------------------------------|
 * | `trialing`             | `pro` — the trial runs at pro level |
 * | `active`               | `subscriptionTier ?? 'pro'`         |
 * | `expired` / `canceled` | `pro` — see the note below          |
 *
 * A missing `customers/{uid}` doc resolves as `trialing`: that's a pre-T0
 * account the backfill (`scripts/backfill-customers.mjs`) hasn't reached, and
 * `resolveBillingState(undefined)` already reads it that way.
 *
 * **`expired` / `canceled` deliberately still mint `pro`.** Gating site
 * creation on billing state is *not* this task — the lockout lands with the
 * `requireActiveBilling` gate (task 0.5) wired into the create-site route
 * (task 0.6), and the paid-tier stamp lands with the Stripe webhook (task
 * 2.1). Until then an expired account is blocked at the route, not silently
 * handed a degraded site here; minting `core` now would strand roost data on
 * sites created during the window and read as an enforcement gate that
 * nothing else in the codebase agrees with yet.
 *
 * Takes the already-resolved `billingState` rather than resolving its own:
 * the caller needs the same value for the one-site limit (wave 2.7), and two
 * independent resolutions of the same doc are two things that can drift.
 */
function deriveSiteTier(
  customer: CustomerDocLike | undefined,
  billingState: BillingState,
): SiteTier {
  if (billingState === 'active') {
    return parseSubscriptionTier(customer?.subscriptionTier) ?? UNENTITLED_DEFAULT_TIER;
  }
  return UNENTITLED_DEFAULT_TIER;
}

/**
 * Whether this owner has already used up core's single-site allowance
 * (billing-system wave 2.7).
 *
 * Applies to exactly one shape of account: `active` (a real, paying
 * subscription) **and** `subscriptionTier === 'core'`. Everything else is
 * untouched, deliberately:
 *
 * - `trialing` — the trial runs at the pro feature level, so a customer
 *   evaluating the product may create as many sites as they like. Whether
 *   those sites survive a later core conversion is that conversion's
 *   problem, not a reason to cripple the trial.
 * - `pro` (and a subscriber with no `subscriptionTier` stamped yet, which
 *   `deriveSiteTier` reads as pro) — unlimited sites, as sold.
 * - `expired` / `canceled` — already blocked upstream by the lockout gate.
 *   Answering `tier_insufficient` here would tell a locked-out customer to
 *   *upgrade* when what they need is to reactivate.
 *
 * Costs one `sites where owner == uid` query, `limit(1)` because this is an
 * existence check — the exact count is never reported, so reading the whole
 * portfolio to learn "at least one" would be waste. Sites are hard-deleted
 * (`deleteSite` removes the doc), so there is no soft-delete tombstone to
 * filter out and a match is always a live site.
 */
async function coreSiteLimitReached(
  db: Firestore,
  ownerUid: string,
  customer: CustomerDocLike | undefined,
  billingState: BillingState,
): Promise<boolean> {
  if (billingState !== 'active') return false;
  if (parseSubscriptionTier(customer?.subscriptionTier) !== 'core') return false;

  const owned = await db
    .collection('sites')
    .where('owner', '==', ownerUid)
    .limit(1)
    .get();
  return !owned.empty;
}

export interface CreateSiteInput {
  siteId: string;
  name: string;
  ownerUid: string;
  timezone?: string;
  /** Inject a Firestore instance; tests pass a mock, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: () => Date;
}

export interface CreateSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type CreateSiteResult =
  | { kind: 'invalid_site_id'; reason: string }
  | { kind: 'invalid_name'; reason: string }
  | { kind: 'already_exists' }
  /**
   * Owner is on a core subscription and already owns a site (wave 2.7).
   * The route renders this as `403 tier_insufficient` — see
   * `coreSiteLimitDetail()` for the copy.
   */
  | { kind: 'core_site_limit' }
  | {
      kind: 'created';
      siteId: string;
      name: string;
      timezone: string;
      owner: string;
      tier: SiteTier;
      createdAt: number;
    };

export async function createSite(
  ctx: CreateSiteContext,
  input: CreateSiteInput,
): Promise<CreateSiteResult> {
  if (!input.ownerUid) throw new Error('ownerUid is required');

  const idCheck = validateSiteId(input.siteId);
  if (!idCheck.isValid) {
    return { kind: 'invalid_site_id', reason: idCheck.error ?? 'invalid site id' };
  }

  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length === 0) {
    return { kind: 'invalid_name', reason: 'site name is required' };
  }
  if (trimmedName.length > NAME_MAX_LENGTH) {
    return {
      kind: 'invalid_name',
      reason: `site name must be ${NAME_MAX_LENGTH} characters or fewer`,
    };
  }

  const timezone =
    typeof input.timezone === 'string' && input.timezone.length > 0
      ? input.timezone
      : 'UTC';

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);

  const existing = await siteRef.get();
  if (existing.exists) {
    return { kind: 'already_exists' };
  }

  const nowDate = (input.now ?? (() => new Date()))();

  // Tier is derived from the owner's billing state, not a global constant —
  // see `deriveSiteTier` for the decision table. A read failure here is left
  // to propagate: the `siteRef.get()` above already proves the db is
  // reachable, so a failure at this point is a real fault, and guessing an
  // entitlement is worse than a retryable error on a rare, user-initiated
  // action. The same reasoning covers the site-count query below.
  const customerSnap = await db.collection('customers').doc(input.ownerUid).get();
  const customer = customerSnap.exists ? customerSnap.data() : undefined;
  const billingState = resolveBillingState(customer, nowDate);

  // Core's one-site limit (wave 2.7). Checked after `already_exists` so a
  // colliding id still reports the collision — that is the failure the caller
  // can actually fix by retrying with a different id.
  if (await coreSiteLimitReached(db, input.ownerUid, customer, billingState)) {
    return { kind: 'core_site_limit' };
  }

  const tier = deriveSiteTier(customer, billingState);

  await siteRef.set({
    name: trimmedName,
    createdAt: nowDate,
    owner: input.ownerUid,
    timezone,
    tier,
    // Stamped by the billing events that move a site between tiers (wave
    // 2.1). `null` at creation: the site was minted at this tier, never
    // upgraded into it.
    tierUpgradedAt: null,
  });

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'created',
      owner: input.ownerUid,
      timezone,
      tier,
    },
  });

  return {
    kind: 'created',
    siteId: input.siteId,
    name: trimmedName,
    timezone,
    owner: input.ownerUid,
    tier,
    createdAt: nowDate.getTime(),
  };
}
