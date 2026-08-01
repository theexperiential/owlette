/**
 * POST /api/admin/billing/customers/{uid} — the three admin billing overrides
 *                                            (billing-system task 4.1).
 *
 * Body is a discriminated union on `operation`:
 *
 *   { operation: 'extend_trial', days: 7 }
 *   { operation: 'extend_trial', trialEndsAt: 1767225600000 }
 *   { operation: 'set_tier', tier: 'pro', note: 'conference comp, expires Q3' }
 *   { operation: 'force_expire' }
 *
 * The whole decision matrix — including what an extension does to the trial
 * email markers and the offline-alert mute — lives in
 * `@/lib/billing/billingOverride.server`. This module is HTTP plumbing:
 * authorization, idempotency, parameter validation, and the audit emit.
 *
 * ## Auth
 *
 * `authorizedPlatformHandler` — superadmin only, identical wrapper and gate to
 * `/api/users/{uid}/promote`. `targetIdParam: 'uid'` so the wrapper's own
 * allow/deny audit rows name the customer that was touched, not the platform
 * sentinel.
 *
 * ## Two audit trails, on purpose
 *
 * The wrapper writes the *authorization* decision to `global/audit_log`
 * (who was allowed to call this, under which capability). The
 * `emitMutation('billing_mutated')` below records the *effect* — which
 * operation ran, and what it did to the account's state. The users routes make
 * the same pairing; neither replaces the other.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemNotFound, problemValidation } from '@/lib/apiErrors';
import {
  authorizedPlatformHandler,
  type PlatformHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { emitMutation } from '@/lib/auditLogClient';
import { withIdempotency } from '@/lib/idempotency';
import {
  applyBillingOverride,
  parseBillingOverrideInput,
} from '@/lib/billing/billingOverride.server';
import type { AdminBillingOverrideResponse } from '@/lib/types/billingAdmin';
import { applyAuthDeprecations, readAndParseJsonBody } from '../../../../_shared';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext ? `apiKey:${ctx.auth.keyContext.keyId}` : `user:${ctx.actor.userId}`;
}

export const POST = authorizedPlatformHandler<RouteParams>({
  capability: Capability.BILLING_MANAGE,
  targetKind: 'user',
  targetIdParam: 'uid',
})(async (request: NextRequest, ctx: PlatformHandlerContext, routeContext) => {
  try {
    const { uid } = await routeContext!.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const input = parseBillingOverrideInput(parsed.body);
        if (!input.ok) {
          return problemValidation('invalid billing override', {
            [input.field]: [input.message],
          });
        }

        const result = await applyBillingOverride(uid, input.input, ctx.actor.userId);

        if (result.kind === 'not_found') {
          return problemNotFound(
            `no billing customer for ${uid}; the account has not been backfilled`,
          );
        }
        if (result.kind === 'invalid_input') {
          return problemValidation('invalid billing override', {
            [result.field]: [result.message],
          });
        }

        const body: AdminBillingOverrideResponse = {
          uid: result.uid,
          operation: result.operation,
          previousBillingState: result.previousBillingState,
          billingState: result.billingState,
          trialEndsAt: result.trialEndsAt,
          subscriptionTier: result.subscriptionTier,
          comped: result.comped,
          clearedTrialEmailMarkers: result.clearedTrialEmailMarkers,
          clearedAlertMute: result.clearedAlertMute,
        };

        // Platform-scoped mutation: `siteId: ''` routes it to the platform
        // audit tenant, exactly as `user_mutated` / `installer_mutated` do.
        // The note is deliberately included — a comp with no recorded reason
        // is the thing this audit trail exists to prevent — but nothing
        // Stripe-side (customer id, subscription id) ever is.
        emitMutation({
          kind: 'billing_mutated',
          siteId: '',
          actor: auditActor(ctx),
          targetId: uid,
          attributes: {
            endpoint: `/api/admin/billing/customers/${uid}`,
            method: 'POST',
            operation: result.operation,
            from: result.previousBillingState,
            to: result.billingState,
            trialEndsAt: result.trialEndsAt,
            subscriptionTier: result.subscriptionTier,
            comped: result.comped,
            ...(input.input.operation === 'set_tier' ? { note: input.input.note } : {}),
            clearedTrialEmailMarkers: result.clearedTrialEmailMarkers,
            clearedAlertMute: result.clearedAlertMute,
          },
        });

        return applyAuthDeprecations(NextResponse.json(body), ctx.scopeCheck);
      },
    );
  } catch (error) {
    return problemFromError(error, 'admin/billing/customers/[uid]:POST');
  }
});
