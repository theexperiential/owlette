/**
 * GET    /api/sites/{siteId}/presets/reboot/{presetId}
 * PATCH  /api/sites/{siteId}/presets/reboot/{presetId}
 * DELETE /api/sites/{siteId}/presets/reboot/{presetId}
 *
 * Capability: PRESET_MANAGE.
 *
 * security-boundary-migration wave 3.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { readAndParseJsonBody } from '@/app/api/_shared';
import { RestartPresetValidationError } from '@/lib/actions/createRestartPreset.server';
import {
  updateRestartPreset,
  RestartPresetNotFoundError,
  type UpdateRestartPresetInput,
} from '@/lib/actions/updateRestartPreset.server';
import { deleteRestartPreset } from '@/lib/actions/deleteRestartPreset.server';

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
      .collection('reboot_presets')
      .doc(presetId)
      .get();

    if (!presetSnap.exists) return problemNotFound('restart preset not found');
    const data = presetSnap.data() ?? {};
    return NextResponse.json({
      id: presetId,
      name: typeof data.name === 'string' ? data.name : '',
      description: typeof data.description === 'string' ? data.description : null,
      enabled: typeof data.enabled === 'boolean' ? data.enabled : null,
      entries: Array.isArray(data.entries) ? data.entries : [],
      isBuiltIn: data.isBuiltIn === true,
      order: typeof data.order === 'number' ? data.order : 0,
      createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
      createdAt: timestampToIso(data.createdAt),
      updatedAt: timestampToIso(data.updatedAt),
    });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/reboot/[presetId]:GET');
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
    const body = (parsed.body ?? {}) as UpdateRestartPresetInput;

    const result = await updateRestartPreset(ctx, presetId, body);
    return NextResponse.json({
      presetId: result.presetId,
      siteId: result.siteId,
      isBuiltInOverride: result.isBuiltInOverride,
    });
  } catch (err) {
    if (err instanceof RestartPresetValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof RestartPresetNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/reboot/[presetId]:PATCH');
  }
});

export const DELETE = authorizedSiteHandler<{ siteId: string; presetId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { presetId } = await routeContext.params;
    await deleteRestartPreset(ctx, presetId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof RestartPresetValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof RestartPresetNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/reboot/[presetId]:DELETE');
  }
});
