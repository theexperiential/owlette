/**
 * GET /api/admin/billing/overview — the billing ops dashboard
 *                                    (billing-system task 4.2).
 *
 * One superadmin round trip that answers "how is the business doing and who
 * needs a phone call": account counts by billing state and tier, an MRR
 * projection, trial conversion, and the roost storage leaderboard.
 *
 * ## Auth
 *
 * `authorizedPlatformHandler` — superadmin only, the same wrapper, 403 and
 * blocking allow-audit as the sibling customers route.
 *
 * ## One route, all the aggregation
 *
 * Everything is computed server-side with the admin SDK. There is no client
 * Firestore access on this page and no `firestore.rules` change behind it: the
 * dashboard reads `customers/*`, every site's `roost/quota`, and each
 * subscribed account's usage mirror, none of which the browser can — or should
 * — reach. The scan cost and the lever for when it stops being acceptable are
 * documented on `buildBillingOverview()`.
 *
 * ## The MRR number is a projection
 *
 * It re-runs `pricing.ts` at list price over the latest usage mirrors, not
 * Stripe's invoices. `mrr.withUsage` reports how many of the counted accounts
 * had a mirror to project from; when it is below `mrr.accounts` the figure is
 * a floor, and the page says so.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import {
  authorizedPlatformHandler,
  type PlatformHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { buildBillingOverview } from '@/lib/billing/billingOps.server';
import { applyAuthDeprecations } from '../../../_shared';

export const GET = authorizedPlatformHandler({
  capability: Capability.BILLING_MANAGE,
  targetKind: 'user',
})(async (_request: NextRequest, ctx: PlatformHandlerContext) => {
  try {
    const body = await buildBillingOverview();

    // Private and uncacheable — whole-fleet revenue and per-account storage.
    return applyAuthDeprecations(
      NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } }),
      ctx.scopeCheck,
    );
  } catch (error) {
    return problemFromError(error, 'admin/billing/overview:GET');
  }
});
