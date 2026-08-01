// @auth-bypass: "actor IS target" — the caller converts their OWN account.
// `authorizedPlatformHandler` requires superadmin (wrong: every account owner
// buys their own subscription) and `authorizedSiteHandler` requires a siteId
// (wrong: billing is account-level, and an account may own no sites).
// Auth is enforced inline below; see the file header.
/**
 * POST /api/billing/checkout — Stripe Checkout session for conversion
 *                              (billing-system wave 2.1).
 *
 * The one way an owlette account starts paying. The caller picks `core` or
 * `pro`, this mints a Stripe-hosted Checkout session in `subscription` mode,
 * and the browser is redirected to it. Stripe collects the card; the
 * `customer.subscription.created` webhook is what actually grants the tier.
 *
 * ## Auth model
 *
 * Session or freshly-issued ID token only (`requireSessionOrIdToken` with
 * `rejectAgentTokens`), never an api key — same posture as the billing portal.
 * The session it returns attaches a payment method to this account's Stripe
 * customer and starts charging it; a scraped CLI key must not be able to
 * reach it.
 *
 * Owner-only falls out of the addressing rather than a role check: the
 * customer record is `customers/{uid}` keyed on the *verified* caller uid, so
 * there is no parameter through which one account could buy a subscription on
 * another's behalf. `assertActiveUser` additionally refuses a soft-deleted
 * account holding a stale session.
 *
 * ## This route grants nothing
 *
 * **Checkout never writes `subscriptionTier`, `billingState`, or a site's
 * `tier`.** The webhook is the single writer of entitlement, and it derives
 * the tier from the *prices on the subscription* — not from anything the
 * client sent. A session that is created and then abandoned must leave the
 * account exactly as it was, which is only true if this handler's sole
 * persistent effect is linking a Stripe customer.
 *
 * `metadata.uid` / `metadata.tier` ride along on both the session and the
 * subscription as the audit trail: they answer "who clicked what, when" when
 * a support ticket needs reconciling against Stripe. They are deliberately
 * *not* the webhook's tier input.
 *
 * ## Trial model
 *
 * owlette's 14-day trial is app-managed in Firestore (no card, so no Stripe
 * subscription exists during it — see `plan.md` → trial model). Consequently
 * this session sets **no** `subscription_data.trial_period_days` / `trial_end`:
 * billing starts at conversion. Adding a Stripe-side trial here would hand a
 * converting customer a second free window on top of the one they already had.
 *
 * ## Metered line items
 *
 * Every price this route attaches is metered (per-active-machine, and roost
 * storage overage on pro), reported by the daily usage cron rather than fixed
 * at checkout — so the line items carry a bare `price` and no quantity.
 *
 * Verified against the installed `stripe@22.4.0` typings rather than from
 * memory (`cjs/resources/Checkout/Sessions.d.ts`,
 * `cjs/resources/Prices.d.ts`):
 *
 *  - `SessionCreateParams.LineItem.quantity` is documented **"Quantity should
 *    not be defined when `recurring.usage_type=metered`"**. That is the only
 *    metered-specific constraint the checkout params carry; `price` alone is a
 *    complete line item (`price_data` is the alternative, not a companion).
 *  - `Price.Recurring` in this api version (`2026-07-29.dahlia`) still carries
 *    **both** `usage_type: 'licensed' | 'metered'` *and* a newer `meter`
 *    field, described as "the meter tracking the usage of a metered price" —
 *    i.e. Billing Meters is an addition to the metered usage type, not a
 *    replacement for it, and the SDK ships the `billing.meters` /
 *    `billing.meterEvents` resources alongside the legacy usage-record path.
 *
 * Either provisioning choice in task 1.1 therefore lands on `usage_type:
 * 'metered'` and the same quantity-less line item, so this file does not need
 * to know which one the price ids were created with.
 *
 * ## Error shapes
 *
 * - **400 `validation_failed`** — body is not `{ tier: 'core' | 'pro' }`.
 * - **409 `already_subscribed`** — the account resolves to `'active'` (which
 *   includes `past_due`; Stripe's dunning owns that window). Plan changes and
 *   cancellation belong to the billing portal, not a second subscription.
 *   `'trialing'`, `'expired'` and `'canceled'` all pass: early conversion and
 *   reactivation are the same code path.
 * - **503 `billing_unavailable`** — Stripe is not configured on this
 *   deployment, or the chosen tier's price ids are not set. Both are
 *   deployment state, not caller state; blaming the caller would send the
 *   client chasing a fix it cannot make.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import {
  ApiAuthError,
  assertActiveUser,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { resolveBillingState, type BillingStateSource } from '@/lib/billing/billingState';
import { linkStripeCustomer } from '@/lib/billing/stripeCustomer.server';
import logger from '@/lib/logger';
import { getStripeOrNull } from '@/lib/stripe.server';
import type { SiteTier } from '@/lib/siteTier';
import { withRateLimit } from '@/lib/withRateLimit';
import { isProduction } from '@/lib/resendClient.server';

/**
 * Env vars holding the Stripe price ids each tier subscribes to, in the order
 * they are attached to the session.
 *
 * Named here rather than read inline so the 503 can report *which* tier is
 * unprovisioned without the route knowing anything about price semantics.
 * Values are mode-specific (test ids on dev, live ids on prod) under the same
 * key names — see `scripts/env-manifest.json`.
 *
 * pro carries the storage-overage price as a second subscription item so roost
 * overage lands on the same invoice as the machine charge; core has no roost
 * entitlement and therefore no overage item.
 */
const TIER_PRICE_ENV_VARS: Record<SiteTier, readonly string[]> = {
  core: ['STRIPE_PRICE_CORE_MACHINE'],
  pro: ['STRIPE_PRICE_PRO_MACHINE', 'STRIPE_PRICE_PRO_STORAGE_OVERAGE'],
};

/** The request body, once validated. */
interface CheckoutBody {
  tier: SiteTier;
}

function parseBody(raw: unknown): CheckoutBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const tier = (raw as { tier?: unknown }).tier;
  if (tier !== 'core' && tier !== 'pro') return null;
  return { tier };
}

/**
 * Resolve the price ids for a tier, or `null` when any of them is unset.
 *
 * All-or-nothing on purpose: a pro session missing only the overage price
 * would check out cleanly and then silently never bill for storage. Partial
 * provisioning has to read as "not provisioned".
 *
 * Trimmed for the same reason `stripe.server.ts` trims its key — a deploy
 * platform that stores an empty string (Railway does) must not hand Stripe a
 * blank price id.
 */
function resolvePriceIds(tier: SiteTier): string[] | null {
  const names = TIER_PRICE_ENV_VARS[tier];
  const resolved: string[] = [];
  const missing: string[] = [];

  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) resolved.push(value);
    else missing.push(name);
  }

  if (missing.length > 0) {
    // Names only, never values — and price ids are not secrets, but the habit
    // of never logging configured billing values is worth keeping intact.
    logger.error('stripe price ids are not configured for this tier', {
      context: 'billing/checkout',
      data: { tier, missing },
    });
    return null;
  }

  return resolved;
}

/**
 * Where Stripe returns the customer after checkout completes or is abandoned.
 *
 * Same derivation as the portal route: the public origin, never the request's
 * Host header — a spoofing proxy must not be able to plant an off-site link in
 * a Stripe-hosted page. The destination is fixed at `/dashboard` rather than
 * echoing a client-supplied path for the same reason (a `returnTo` parameter
 * here would be an open redirect with Stripe's branding on it).
 *
 * The two urls differ only by the marker, so a post-checkout surface can tell
 * a completed session from an abandoned one. The webhook is asynchronous, so a
 * customer can land back on the dashboard a moment before their tier is
 * granted; the marker is what a "finishing up your subscription" hint keys off.
 */
function checkoutReturnUrl(outcome: 'success' | 'canceled'): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');
  return `${baseUrl}/dashboard?checkout=${outcome}`;
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      const userData = await assertActiveUser(userId);

      const body = parseBody(await request.json().catch(() => null));
      if (!body) {
        return problemValidation("tier must be 'core' or 'pro'", {
          tier: ["expected 'core' or 'pro'"],
        });
      }
      const { tier } = body;

      const stripe = getStripeOrNull();
      if (!stripe) {
        return problem({
          type: ProblemType.ServiceUnavailable,
          title: 'billing unavailable',
          status: 503,
          detail: 'billing is not enabled on this deployment yet',
          code: 'billing_unavailable',
          instance: request.nextUrl.pathname,
        });
      }

      const priceIds = resolvePriceIds(tier);
      if (!priceIds) {
        return problem({
          type: ProblemType.ServiceUnavailable,
          title: 'billing unavailable',
          status: 503,
          detail: `the ${tier} plan is not available on this deployment yet`,
          code: 'billing_unavailable',
          instance: request.nextUrl.pathname,
        });
      }

      const db = getAdminDb();
      const customerSnap = await db.collection('customers').doc(userId).get();
      const customerDoc = customerSnap.exists
        ? (customerSnap.data() as (BillingStateSource & { stripeCustomerId?: unknown }) | undefined) ?? null
        : null;

      // Resolved, never read off the stored `billingState` mirror — an
      // 'expired' account whose mirror is stale must still be able to convert,
      // and an 'active' one whose mirror is stale must not be able to buy a
      // second subscription.
      if (resolveBillingState(customerDoc) === 'active') {
        return problem({
          type: ProblemType.Conflict,
          title: 'already subscribed',
          status: 409,
          detail:
            'this account already has a subscription; change or cancel it from billing settings',
          code: 'already_subscribed',
          instance: request.nextUrl.pathname,
        });
      }

      const stripeCustomerId = await resolveCustomerId(db, userId, userData, customerDoc);

      const metadata = { uid: userId, tier };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        // No `quantity` — every price here is metered. See the file header.
        line_items: priceIds.map((price): Stripe.Checkout.SessionCreateParams.LineItem => ({
          price,
        })),
        // Explicit even though it is the SDK default: all of our line items are
        // metered, so the first invoice is $0, and an `if_required` default
        // would create a subscription with no card on file that then dunned on
        // the first real invoice.
        payment_method_collection: 'always',
        metadata,
        // Mirrored onto the subscription so the audit trail survives the
        // session's 24h expiry. NOT the webhook's tier input — see the header.
        subscription_data: { metadata },
        success_url: checkoutReturnUrl('success'),
        cancel_url: checkoutReturnUrl('canceled'),
      });

      if (!session.url) {
        // Hosted-page sessions always carry a url; the SDK types it nullable
        // for the embedded ui modes. Treat the impossible case as a fault so it
        // reaches Sentry rather than redirecting the browser to "null".
        throw new Error(`checkout session ${session.id} was created without a url`);
      }

      logger.info('created stripe checkout session', {
        context: 'billing/checkout',
        data: { uid: userId, tier, sessionId: session.id },
      });

      return NextResponse.json({ success: true, url: session.url });
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
      // Stripe failures land here. `problemFromError` deliberately withholds
      // the underlying message from the client (it can name objects and
      // account state) while sending the full error to Sentry.
      return problemFromError(error, 'billing/checkout:POST');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);

/**
 * The caller's Stripe customer id, minting one through the shared linker when
 * the account has never had a billing profile.
 *
 * A trialing account has no `stripeCustomerId` when Stripe was unconfigured at
 * signup, so first-conversion has to be able to create one. It goes through
 * `linkStripeCustomer()` rather than `stripe.customers.create()` directly so
 * the `metadata.uid` contract, the email-adoption rules, and the
 * `customers/{uid}` write-back all stay in one place — a second minting path
 * is exactly how two accounts end up sharing a Stripe customer.
 *
 * `linkStripeCustomer()` never throws; a `null` return means Stripe rejected
 * the call or the `customers/{uid}` doc is missing (an account that predates
 * wave 0.1 and was never backfilled). Neither is anything the caller can act
 * on, so both surface as a 500 with a requestId to quote at support.
 */
async function resolveCustomerId(
  db: Firestore,
  uid: string,
  userData: FirebaseFirestore.DocumentData,
  customerDoc: { stripeCustomerId?: unknown } | null,
): Promise<string> {
  const existing = customerDoc?.stripeCustomerId;
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const email = userData.email;
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error(`cannot create a stripe customer for ${uid}: no email on the user doc`);
  }

  const linked = await linkStripeCustomer({ db, uid, email });
  if (!linked) throw new Error(`failed to link a stripe customer for ${uid}`);
  return linked;
}
