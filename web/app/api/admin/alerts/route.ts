/**
 * PUT /api/admin/alerts
 *
 * Replace the alert-rules array on `sites/{siteId}/settings/alerts`.
 * Whole-document semantics: caller submits the full intended `rules` array;
 * server replaces (via `setDoc(..., { merge: true })` so sibling fields the
 * alert evaluator may write are preserved).
 *
 * security-boundary-migration wave 3.11.
 *
 * Capability mis-classification (flagged in route-audit.md §3.11):
 *   The legacy admin alerts page is admin-only in the UI but writes a
 *   *site-scoped* document. For wave 3.11 we keep `GLOBAL_SETTINGS_WRITE`
 *   (superadmin) per the audit's recommendation and accept `siteId` in the
 *   BODY rather than via path. Wave 1.2 follow-up should split this into
 *   `/api/sites/{siteId}/alerts` with a per-site capability.
 *
 * Body:
 *   {
 *     siteId: string,
 *     rules: AlertRule[]
 *   }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  setAlertRules,
  AlertRulesValidationError,
} from '@/lib/actions/setAlertRules.server';

interface PutBody {
  siteId?: unknown;
  rules?: unknown;
}

export const PUT = authorizedPlatformHandler({
  capability: 'GLOBAL_SETTINGS_WRITE',
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PutBody;

    if (typeof body.siteId !== 'string' || body.siteId.length === 0) {
      return problemValidation('field `siteId` is required and must be a non-empty string', {
        'body.siteId': ['required string'],
      });
    }
    if (!Array.isArray(body.rules)) {
      return problemValidation('field `rules` is required and must be an array', {
        'body.rules': ['required array'],
      });
    }

    try {
      const result = await setAlertRules(
        { actor: ctx.actor, siteId: body.siteId },
        // The action core does exhaustive per-rule validation.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { rules: body.rules as any[] },
      );
      return NextResponse.json({
        siteId: result.siteId,
        ruleCount: result.ruleCount,
      });
    } catch (err) {
      if (err instanceof AlertRulesValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'admin/alerts:PUT');
  }
});
