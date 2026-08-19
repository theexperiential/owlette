/**
 * GET    /api/sites/{siteId}/presets/talon/{presetId}
 * PATCH  /api/sites/{siteId}/presets/talon/{presetId}
 * DELETE /api/sites/{siteId}/presets/talon/{presetId}
 *
 * Capability: PRESET_MANAGE — see the sibling `../route.ts` header for why it
 * is that and not `TALON_MANAGE`, and why there is no pro gate.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { TalonPresetValidationError } from '@/lib/actions/createTalonPreset.server';
import {
  updateTalonPreset,
  TalonPresetNotFoundError,
  type UpdateTalonPresetInput,
} from '@/lib/actions/updateTalonPreset.server';
import { deleteTalonPreset } from '@/lib/actions/deleteTalonPreset.server';
import { serializeTalonPreset, talonPresetProblem } from '../route';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface RouteParams {
  params: Promise<{ siteId: string; presetId: string }>;
}

export const GET = authorizedSiteHandler<{ siteId: string; presetId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { presetId } = await routeContext.params;
    if (!PRESET_ID_RE.test(presetId)) {
      return problemValidation('invalid preset id', { presetId: ['must be 1-128 chars: letters, digits, underscore, hyphen'] });
    }

    const db = getAdminDb();
    const presetSnap = await db
      .collection('config')
      .doc(ctx.siteId)
      .collection('talon_presets')
      .doc(presetId)
      .get();

    if (!presetSnap.exists) return problemNotFound('talon preset not found');
    return NextResponse.json(serializeTalonPreset(presetId, presetSnap.data() ?? {}));
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/talon/[presetId]:GET');
  }
});

export const PATCH = authorizedSiteHandler<{ siteId: string; presetId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { presetId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as UpdateTalonPresetInput;

    const result = await updateTalonPreset(ctx, presetId, body);
    return NextResponse.json({
      presetId: result.presetId,
      siteId: result.siteId,
      isBuiltInOverride: result.isBuiltInOverride,
    });
  } catch (err) {
    if (err instanceof TalonPresetValidationError) return talonPresetProblem(err);
    if (err instanceof TalonPresetNotFoundError) return problemNotFound(err.message);
    return problemFromError(err, 'sites/[siteId]/presets/talon/[presetId]:PATCH');
  }
});

export const DELETE = authorizedSiteHandler<{ siteId: string; presetId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { presetId } = await routeContext.params;
    await deleteTalonPreset(ctx, presetId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof TalonPresetValidationError) return talonPresetProblem(err);
    return problemFromError(err, 'sites/[siteId]/presets/talon/[presetId]:DELETE');
  }
});
