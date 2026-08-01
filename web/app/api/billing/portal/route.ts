// @auth-bypass: "actor IS target" — the caller manages their OWN billing.
// `authorizedPlatformHandler` requires superadmin (wrong: every account owner
// manages their own subscription) and `authorizedSiteHandler` requires a
// siteId (wrong: billing is account-level, and an account may own no sites).
// Auth is enforced inline below; see the file header.
/**
 * POST /api/billing/portal — Stripe customer portal session
 *                            (billing-system wave 1.4).
 *
 * Mints a short-lived Stripe Billing Portal session for the calling account
 * and returns its url. The portal is where a customer updates their card,
 * downloads invoices, and cancels — all of it hosted by Stripe, so none of
 * that surface has to exist in owlette.
 *
 * ## Auth model
 *
 * Session or freshly-issued ID token only (`requireSessionOrIdToken` with
 * `rejectAgentTokens`), never an api key. A portal session can cancel a
 * subscription and read every invoice the account has ever received; that is
 * a "you, in person" action, and a scraped CLI key must not be able to reach
 * it. Same reasoning as `DELETE /api/users/me`.
 *
 * Owner-only falls out of the addressing rather than a role check: the
 * customer record is `customers/{uid}` keyed on the *verified* caller uid, so
 * there is no parameter through which one account could request another's
 * portal. `assertActiveUser` additionally refuses a soft-deleted account
 * holding a stale session.
 *
 * ## Error shapes
 *
 * - **409 `no_billing_account`** — the account has no `stripeCustomerId` yet.
 *   That is the normal state for a trialing account that never converted, and
 *   for the window between signup and the customer link succeeding. A conflict
 *   rather than a 404: the account exists, it just isn't in a state where a
 *   portal session can be created.
 * - **503 `billing_unavailable`** — Stripe is not configured on this
 *   deployment (the state until task 1.1 provisions the account). Deliberately
 *   *not* 402/409: nothing is wrong with the caller or their account state, so
 *   blaming them would send the client chasing a fix it cannot make.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
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
  ProblemType,
} from '@/lib/apiErrors';
import { getStripeOrNull } from '@/lib/stripe.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { isProduction } from '@/lib/resendClient.server';

/**
 * Where Stripe sends the customer when they click "return to owlette".
 *
 * Same derivation as the email templates (`emailTemplates.server.ts`) — the
 * public origin, not the request's Host header. Deriving it from the request
 * would let a Host-header-spoofing proxy plant an off-site return url in a
 * Stripe-hosted page.
 */
function dashboardReturnUrl(): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');
  return `${baseUrl}/dashboard`;
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request, { rejectAgentTokens: true });
      await assertActiveUser(userId);

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

      const db = getAdminDb();
      const customerSnap = await db.collection('customers').doc(userId).get();
      const stripeCustomerId = customerSnap.exists
        ? customerSnap.data()?.stripeCustomerId
        : null;

      if (typeof stripeCustomerId !== 'string' || stripeCustomerId.length === 0) {
        return problem({
          type: ProblemType.Conflict,
          title: 'no billing account',
          status: 409,
          detail:
            'this account has no billing profile yet; choose a plan to set one up',
          code: 'no_billing_account',
          instance: request.nextUrl.pathname,
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: dashboardReturnUrl(),
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
      return problemFromError(error, 'billing/portal:POST');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
