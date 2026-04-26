/**
 * DELETE /api/sites/{siteId}/logs
 *
 * Clear log entries from `sites/{siteId}/logs`, optionally constrained by
 * the same filters used by `web/app/logs/page.tsx`: action, machineId, level.
 *
 * Capability mis-classification (flagged in route-audit.md section 3.11):
 *   This is a site-scoped mutation, but wave 3.11 uses
 *   `GLOBAL_SETTINGS_WRITE` because no dedicated `SITE_LOGS_MANAGE`
 *   capability exists yet. The route remains site-scoped for URL/auth
 *   integrity and should move to a narrower capability in the follow-up.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  clearLogs,
  ClearLogsValidationError,
} from '@/lib/actions/clearLogs.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

interface DeleteBody {
  action?: unknown;
  machineId?: unknown;
  level?: unknown;
}

function normalizeOptionalString(
  body: DeleteBody,
  field: keyof DeleteBody,
): string | undefined | NextResponse {
  const value = body[field];
  if (value === undefined || value === null || value === 'all') return undefined;
  if (typeof value !== 'string') {
    return problemValidation(`field \`${field}\` must be a string when provided`, {
      [`body.${field}`]: ['must be a string'],
    });
  }
  return value;
}

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: Capability.GLOBAL_SETTINGS_WRITE,
  siteIdParam: 'path',
  targetKind: 'site',
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as DeleteBody;

    const action = normalizeOptionalString(body, 'action');
    if (action instanceof NextResponse) return action;
    const machineId = normalizeOptionalString(body, 'machineId');
    if (machineId instanceof NextResponse) return machineId;
    const level = normalizeOptionalString(body, 'level');
    if (level instanceof NextResponse) return level;

    try {
      const result = await clearLogs(
        { siteId: ctx.siteId },
        {
          action,
          machineId,
          level,
        },
      );
      return NextResponse.json({
        siteId: result.siteId,
        deletedCount: result.deletedCount,
        filters: result.filters,
      });
    } catch (err) {
      if (err instanceof ClearLogsValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/logs:DELETE');
  }
});
