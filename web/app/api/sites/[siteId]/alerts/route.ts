/**
 * PUT /api/sites/{siteId}/alerts
 *
 * Replace the alert-rules array on `sites/{siteId}/settings/alerts`.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  setAlertRules,
  AlertRulesValidationError,
} from '@/lib/actions/setAlertRules.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

interface PutBody {
  rules?: unknown;
}

export const PUT = authorizedSiteHandler<RouteParams>({
  capability: 'GLOBAL_SETTINGS_WRITE',
  siteIdParam: 'path',
  apiKeyScope: { resource: 'user', id: '*', permission: 'admin' },
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PutBody;

    if (!Array.isArray(body.rules)) {
      return problemValidation('field `rules` is required and must be an array', {
        'body.rules': ['required array'],
      });
    }

    try {
      const result = await setAlertRules(
        { actor: ctx.actor, siteId: ctx.siteId },
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
    return problemFromError(err, 'sites/alerts:PUT');
  }
});
