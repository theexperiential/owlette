/**
 * GET  /api/admin/system-presets
 *      → list all global system presets, sorted by `order` then `name`.
 *
 * POST /api/admin/system-presets
 *      → create a new system preset. Requires SYSTEM_PRESET_MANAGE.
 *
 * security-boundary-migration wave 3.11. Platform-level (superadmin)
 * because system presets are global software-deployment templates shared
 * across every site (Owlette agent, TouchDesigner, etc.).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  createSystemPreset,
  SystemPresetValidationError,
} from '@/lib/actions/createSystemPreset.server';

/* --------------------------------------------------------------------- */
/*  GET — list system presets                                            */
/* --------------------------------------------------------------------- */

export const GET = authorizedPlatformHandler({
  capability: 'SYSTEM_PRESET_MANAGE',
  apiKeyScope: { resource: 'user', permission: 'read' },
})(async () => {
  try {
    const db = getAdminDb();
    const snap = await db.collection('system_presets').get();
    const items = snap.docs.map((d) => serializePreset(d.id, d.data() ?? {}));
    items.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
    return NextResponse.json({ items });
  } catch (err) {
    return problemFromError(err, 'admin/system-presets:GET');
  }
});

/* --------------------------------------------------------------------- */
/*  POST — create system preset                                          */
/* --------------------------------------------------------------------- */

interface CreateBody {
  name?: unknown;
  software_name?: unknown;
  category?: unknown;
  description?: unknown;
  icon?: unknown;
  installer_name?: unknown;
  installer_url?: unknown;
  silent_flags?: unknown;
  verify_path?: unknown;
  close_processes?: unknown;
  parallel_install?: unknown;
  is_owlette_agent?: unknown;
  timeout_seconds?: unknown;
  order?: unknown;
}

export const POST = authorizedPlatformHandler({
  capability: 'SYSTEM_PRESET_MANAGE',
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateBody;

    // shallow type sanity before delegating to the action core (which does
    // exhaustive validation and throws SystemPresetValidationError).
    if (typeof body.name !== 'string') {
      return problemValidation('field `name` is required and must be a string', {
        'body.name': ['required string'],
      });
    }
    if (typeof body.software_name !== 'string') {
      return problemValidation('field `software_name` is required and must be a string', {
        'body.software_name': ['required string'],
      });
    }

    try {
      const result = await createSystemPreset(
        { actor: ctx.actor },
        {
          name: body.name,
          software_name: body.software_name,
          category: typeof body.category === 'string' ? body.category : '',
          description: typeof body.description === 'string' ? body.description : undefined,
          icon: typeof body.icon === 'string' ? body.icon : undefined,
          installer_name: typeof body.installer_name === 'string' ? body.installer_name : '',
          installer_url: typeof body.installer_url === 'string' ? body.installer_url : '',
          silent_flags: typeof body.silent_flags === 'string' ? body.silent_flags : '',
          verify_path: typeof body.verify_path === 'string' ? body.verify_path : undefined,
          close_processes: Array.isArray(body.close_processes)
            ? (body.close_processes as unknown[]).filter((p): p is string => typeof p === 'string')
            : undefined,
          parallel_install:
            typeof body.parallel_install === 'boolean' ? body.parallel_install : undefined,
          is_owlette_agent: body.is_owlette_agent === true,
          timeout_seconds:
            typeof body.timeout_seconds === 'number' ? body.timeout_seconds : undefined,
          order: typeof body.order === 'number' ? body.order : 0,
        },
      );
      return NextResponse.json({ presetId: result.presetId }, { status: 201 });
    } catch (err) {
      if (err instanceof SystemPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'admin/system-presets:POST');
  }
});

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

interface SerializedPreset {
  id: string;
  name: string;
  software_name: string;
  category: string;
  description: string | null;
  icon: string | null;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path: string | null;
  close_processes: string[];
  parallel_install: boolean;
  is_owlette_agent: boolean;
  timeout_seconds: number | null;
  order: number;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

function serializePreset(id: string, data: Record<string, unknown>): SerializedPreset {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    software_name: typeof data.software_name === 'string' ? data.software_name : '',
    category: typeof data.category === 'string' ? data.category : '',
    description: typeof data.description === 'string' ? data.description : null,
    icon: typeof data.icon === 'string' ? data.icon : null,
    installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
    installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
    silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
    verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
    close_processes: Array.isArray(data.close_processes)
      ? (data.close_processes as unknown[]).filter((p): p is string => typeof p === 'string')
      : [],
    parallel_install: data.parallel_install === true,
    is_owlette_agent: data.is_owlette_agent === true,
    timeout_seconds: typeof data.timeout_seconds === 'number' ? data.timeout_seconds : null,
    order: typeof data.order === 'number' ? data.order : 0,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
