/**
 * GET    /api/sites/{siteId}/presets/distribution/{presetId}
 *        → fetch a single distribution preset doc.
 *
 * PATCH  /api/sites/{siteId}/presets/distribution/{presetId}
 *        → update preset (custom edit) or create the override doc for a
 *          built-in preset (when presetId starts with `builtin-`).
 *          Requires PRESET_MANAGE.
 *
 * DELETE /api/sites/{siteId}/presets/distribution/{presetId}
 *        → delete preset (custom) or remove the override doc for a built-in
 *          preset (the hardcoded default re-emerges on next read).
 *          Requires PRESET_MANAGE.
 *
 * security-boundary-migration wave 3.7. Mirrors the schedule/reboot preset
 * routes from wave 3.6 — only the firestore path differs.
 */

import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  updateDistributionPreset,
  DistributionPresetNotFoundError,
} from '@/lib/actions/updateDistributionPreset.server';
import { deleteDistributionPreset } from '@/lib/actions/deleteDistributionPreset.server';
import { DistributionPresetValidationError } from '@/lib/actions/createDistributionPreset.server';

type RouteParams = {
  siteId: string;
  presetId: string;
} & Record<string, string | undefined>;

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validatePresetId(presetId: string | undefined): NextResponse | null {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    return problemValidation('presetId must be 1-128 chars: letters, digits, underscore, hyphen', {
      presetId: ['invalid format'],
    });
  }
  return null;
}

/* --------------------------------------------------------------------- */
/*  GET                                                                  */
/* --------------------------------------------------------------------- */

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  apiKeyPermission: 'read',
})(async (_request, ctx, routeContext) => {
  try {
    const params = await routeContext.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    const db = getAdminDb();
    const snap = await db
      .collection('config')
      .doc(ctx.siteId)
      .collection('project_distribution_presets')
      .doc(presetId as string)
      .get();

    if (!snap.exists) return problemNotFound('preset not found');

    return NextResponse.json(serializePreset(snap.id, snap.data() ?? {}));
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/distribution/[presetId]:GET');
  }
});

/* --------------------------------------------------------------------- */
/*  PATCH                                                                */
/* --------------------------------------------------------------------- */

interface PatchBody {
  name?: unknown;
  description?: unknown;
  project_url?: unknown;
  extract_path?: unknown;
  verify_files?: unknown;
  order?: unknown;
}

export const PATCH = authorizedSiteHandler<RouteParams>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
})(async (request, ctx, routeContext) => {
  try {
    const params = await routeContext.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PatchBody;

    try {
      await updateDistributionPreset(
        { actor: ctx.actor, siteId: ctx.siteId, presetId: presetId as string },
        {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          project_url: typeof body.project_url === 'string' ? body.project_url : undefined,
          extract_path: typeof body.extract_path === 'string' ? body.extract_path : undefined,
          verify_files: Array.isArray(body.verify_files)
            ? (body.verify_files as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined,
          order: typeof body.order === 'number' ? body.order : undefined,
        },
      );
      return NextResponse.json({ presetId, siteId: ctx.siteId });
    } catch (err) {
      if (err instanceof DistributionPresetNotFoundError) {
        return problemNotFound('preset not found');
      }
      if (err instanceof DistributionPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/distribution/[presetId]:PATCH');
  }
});

/* --------------------------------------------------------------------- */
/*  DELETE                                                               */
/* --------------------------------------------------------------------- */

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
})(async (_request, ctx, routeContext) => {
  try {
    const params = await routeContext.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    try {
      await deleteDistributionPreset({
        actor: ctx.actor,
        siteId: ctx.siteId,
        presetId: presetId as string,
      });
      return new NextResponse(null, { status: 204 });
    } catch (err) {
      if (err instanceof DistributionPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/distribution/[presetId]:DELETE');
  }
});

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

interface SerializedPreset {
  id: string;
  name: string;
  description: string | null;
  project_url: string | null;
  extract_path: string | null;
  verify_files: string[];
  order: number;
  isBuiltIn: boolean;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

function serializePreset(id: string, data: Record<string, unknown>): SerializedPreset {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : null,
    project_url: typeof data.project_url === 'string' ? data.project_url : null,
    extract_path: typeof data.extract_path === 'string' ? data.extract_path : null,
    verify_files: Array.isArray(data.verify_files)
      ? (data.verify_files as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    order: typeof data.order === 'number' ? data.order : 0,
    isBuiltIn: data.isBuiltIn === true,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
