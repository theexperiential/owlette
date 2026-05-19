/**
 * GET    /api/sites/{siteId}/presets/schedule/{presetId}
 * PATCH  /api/sites/{siteId}/presets/schedule/{presetId}
 * DELETE /api/sites/{siteId}/presets/schedule/{presetId}
 *
 * Capability: PRESET_MANAGE.
 *
 * Built-in presets (id starts with `builtin-`) on PATCH use setDoc({merge}),
 * which both creates the override doc on first edit and updates it on
 * subsequent edits — see `useSchedulePresets.ts:158`. Custom presets
 * require an existing doc and are updated via updateDoc.
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
import { SchedulePresetValidationError } from '@/lib/actions/createSchedulePreset.server';
import {
  updateSchedulePreset,
  SchedulePresetNotFoundError,
  type UpdateSchedulePresetInput,
} from '@/lib/actions/updateSchedulePreset.server';
import { deleteSchedulePreset } from '@/lib/actions/deleteSchedulePreset.server';

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
      .collection('schedule_presets')
      .doc(presetId)
      .get();

    if (!presetSnap.exists) return problemNotFound('schedule preset not found');
    const data = presetSnap.data() ?? {};
    return NextResponse.json({
      id: presetId,
      name: typeof data.name === 'string' ? data.name : '',
      description: typeof data.description === 'string' ? data.description : null,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      isBuiltIn: data.isBuiltIn === true,
      order: typeof data.order === 'number' ? data.order : 0,
      createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
      createdAt: timestampToIso(data.createdAt),
      updatedAt: timestampToIso(data.updatedAt),
    });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/schedule/[presetId]:GET');
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
    const body = (parsed.body ?? {}) as UpdateSchedulePresetInput;

    const result = await updateSchedulePreset(ctx, presetId, body);
    return NextResponse.json({
      presetId: result.presetId,
      siteId: result.siteId,
      isBuiltInOverride: result.isBuiltInOverride,
    });
  } catch (err) {
    if (err instanceof SchedulePresetValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof SchedulePresetNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/schedule/[presetId]:PATCH');
  }
});

export const DELETE = authorizedSiteHandler<{ siteId: string; presetId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { presetId } = await routeContext.params;
    await deleteSchedulePreset(ctx, presetId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof SchedulePresetValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof SchedulePresetNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/schedule/[presetId]:DELETE');
  }
});
