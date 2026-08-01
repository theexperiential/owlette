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
 */
function deriveSiteTier(customer: CustomerDocLike | undefined, now: Date): SiteTier {
  if (resolveBillingState(customer, now) === 'active') {
    return parseSubscriptionTier(customer?.subscriptionTier) ?? UNENTITLED_DEFAULT_TIER;
  }
  return UNENTITLED_DEFAULT_TIER;
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
  // action.
  const customerSnap = await db.collection('customers').doc(input.ownerUid).get();
  const tier = deriveSiteTier(
    customerSnap.exists ? customerSnap.data() : undefined,
    nowDate,
  );

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
