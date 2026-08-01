/**
 * GET /api/admin/billing/customers — the admin customers table
 *                                     (billing-system task 4.1).
 *
 * Every `customers/{uid}` doc with its **live** billing state, tier, comp
 * provenance and trial clock, joined to the owning user's email so an admin
 * can find an account by the address the customer wrote in.
 *
 * ## Auth
 *
 * `authorizedPlatformHandler` — superadmin only, same wrapper and same
 * `role !== 'superadmin' → 403 'superadmin access required'` gate as
 * `/api/platform/security/kill-switch` and `/api/users/{uid}/promote`. It also
 * writes the blocking allow-audit, so opening this list leaves a trail: a
 * response that names every account's billing position is not a neutral read.
 *
 * ## Why a route and not a client listener
 *
 * `customers/*` has no client-readable `firestore.rules` match and must not
 * gain one for an admin table — the same reasoning as `/api/billing/snapshot`,
 * and the same class of bug as the `useUserManagement` users listener
 * (OWLETTE-WEB-3R). Reading server-side with the admin SDK needs no rules
 * change at all.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  authorizedPlatformHandler,
  type PlatformHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  CUSTOMER_LIST_DEFAULT_LIMIT,
  CUSTOMER_LIST_MAX_LIMIT,
  listBillingCustomers,
} from '@/lib/billing/billingOps.server';
import type { BillingState } from '@/lib/types/customer';
import { applyAuthDeprecations } from '../../../_shared';

const BILLING_STATES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'expired',
  'canceled',
]);

export const GET = authorizedPlatformHandler({
  capability: Capability.BILLING_MANAGE,
  targetKind: 'user',
})(async (request: NextRequest, ctx: PlatformHandlerContext) => {
  try {
    const params = request.nextUrl.searchParams;

    const rawState = params.get('state');
    if (rawState !== null && !BILLING_STATES.has(rawState)) {
      return problemValidation('state must be a billing state', {
        'query.state': ['must be one of: trialing, active, expired, canceled'],
      });
    }

    const rawLimit = params.get('limit');
    let limit = CUSTOMER_LIST_DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > CUSTOMER_LIST_MAX_LIMIT) {
        return problemValidation('limit must be a positive integer', {
          'query.limit': [`must be a whole number between 1 and ${CUSTOMER_LIST_MAX_LIMIT}`],
        });
      }
      limit = parsed;
    }

    const body = await listBillingCustomers({
      query: params.get('q') ?? undefined,
      state: (rawState as BillingState | null) ?? undefined,
      limit,
    });

    // Private and uncacheable: this names every account's billing position,
    // and a shared cache serving it onward would be a data leak.
    return applyAuthDeprecations(
      NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } }),
      ctx.scopeCheck,
    );
  } catch (error) {
    return problemFromError(error, 'admin/billing/customers:GET');
  }
});
