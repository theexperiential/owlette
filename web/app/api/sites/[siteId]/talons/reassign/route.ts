/**
 * POST /api/sites/{siteId}/talons/reassign — move talon authorship.
 *
 * Batch by design: a departure moves every talon one person wrote, and N calls
 * to the item route would be N audit transactions and N chances to stop
 * half-way. One call, one atomic commit.
 *
 * Body `{ toUid, fromUid? | talonIds? }` — exactly one selector.
 *
 * Thin shim: selection, successor eligibility, commit, and audit all live in
 * `@/lib/talons/store.server` so no caller can sidestep them.
 * Capability: TALON_MANAGE.
 *
 * Safe as a static segment beside `[talonId]` — auto-ids are 20 alphanumeric
 * chars, so no talon can be addressed as `reassign`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readAndParseJsonBody } from '@/app/api/_shared';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import { reassignTalons, TalonStoreError } from '@/lib/talons/store.server';

import { talonStoreContext, talonStoreProblem } from '../route';

// The store module pulls in `node:crypto` for webhook secret minting.
export const runtime = 'nodejs';

type RouteParams = { siteId: string };

interface ReassignBody {
  toUid?: unknown;
  fromUid?: unknown;
  talonIds?: unknown;
}

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const body = (parsed.body ?? {}) as ReassignBody;
    if (typeof body.toUid !== 'string') {
      return problemValidation('toUid is required', {
        'body.toUid': ['must be the user id of the successor'],
      });
    }
    if (body.talonIds !== undefined && !Array.isArray(body.talonIds)) {
      return problemValidation('talonIds must be an array', {
        'body.talonIds': ['must be an array of talon ids'],
      });
    }
    if (body.fromUid !== undefined && typeof body.fromUid !== 'string') {
      return problemValidation('fromUid must be a string', {
        'body.fromUid': ['must be the user id whose talons are being moved'],
      });
    }

    const idem = await checkIdempotency(
      request,
      {
        userId: ctx.auth.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    const result = await reassignTalons(
      getAdminDb(),
      talonStoreContext(request, ctx),
      body.toUid,
      {
        ...(body.fromUid !== undefined ? { fromUid: body.fromUid } : {}),
        ...(body.talonIds !== undefined ? { talonIds: body.talonIds as string[] } : {}),
      },
    );

    const response = NextResponse.json({
      ...result,
      reassignedCount: result.reassignedTalonIds.length,
    });
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/talons/reassign:POST');
  }
});
