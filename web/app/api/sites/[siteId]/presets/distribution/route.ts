/**
 * GET  /api/sites/{siteId}/presets/distribution
 *      → list distribution presets for a site (custom + built-in overrides
 *        as stored in firestore). Hardcoded built-in defaults are not
 *        merged here — that merge is a UI-layer concern.
 *
 * POST /api/sites/{siteId}/presets/distribution
 *      → create a custom distribution preset. Requires PRESET_MANAGE.
 *
 * security-boundary-migration wave 3.7. Mirrors the schedule/reboot preset
 * routes from wave 3.6 — only the firestore path differs.
 */

import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  createDistributionPreset,
  DistributionPresetValidationError,
} from '@/lib/actions/createDistributionPreset.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

/* --------------------------------------------------------------------- */
/*  GET — list distribution presets                                      */
/* --------------------------------------------------------------------- */

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  apiKeyPermission: 'read',
})(async (_request, ctx) => {
  try {
    const db = getAdminDb();
    const snap = await db
      .collection('config')
      .doc(ctx.siteId)
      .collection('project_distribution_presets')
      .get();

    const items = snap.docs.map((d) => serializePreset(d.id, d.data() ?? {}));
    items.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ items });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/distribution:GET');
  }
});

/* --------------------------------------------------------------------- */
/*  POST — create distribution preset                                    */
/* --------------------------------------------------------------------- */

interface CreateBody {
  name?: unknown;
  description?: unknown;
  project_url?: unknown;
  extract_path?: unknown;
  verify_files?: unknown;
  order?: unknown;
  isBuiltIn?: unknown;
}

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
})(async (request, ctx) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateBody;

    // shallow type sanity before delegating to the action core (which does
    // exhaustive validation and throws DistributionPresetValidationError).
    if (typeof body.name !== 'string') {
      return problemValidation('field `name` is required and must be a string', {
        'body.name': ['required string'],
      });
    }

    try {
      const result = await createDistributionPreset(
        { actor: ctx.actor, siteId: ctx.siteId },
        {
          name: body.name,
          description: typeof body.description === 'string' ? body.description : undefined,
          project_url: typeof body.project_url === 'string' ? body.project_url : undefined,
          extract_path: typeof body.extract_path === 'string' ? body.extract_path : undefined,
          verify_files: Array.isArray(body.verify_files)
            ? (body.verify_files as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined,
          order: typeof body.order === 'number' ? body.order : 0,
          isBuiltIn: body.isBuiltIn === true,
        },
      );
      return NextResponse.json(
        { presetId: result.presetId, siteId: ctx.siteId },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof DistributionPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/distribution:POST');
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
