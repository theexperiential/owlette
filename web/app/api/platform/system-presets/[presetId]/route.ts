/**
 * GET/PATCH/DELETE /api/platform/system-presets/{presetId}
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
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  updateSystemPreset,
  SystemPresetNotFoundError,
} from '@/lib/actions/updateSystemPreset.server';
import { deleteSystemPreset } from '@/lib/actions/deleteSystemPreset.server';
import { SystemPresetValidationError } from '@/lib/actions/createSystemPreset.server';

type RouteParams = {
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

export const GET = authorizedPlatformHandler<RouteParams>({
  capability: 'SYSTEM_PRESET_MANAGE',
  targetKind: 'preset',
  apiKeyScope: { resource: 'user', permission: 'read' },
})(async (_request, _ctx, routeContext) => {
  try {
    const params = await routeContext!.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    const db = getAdminDb();
    const snap = await db.collection('system_presets').doc(presetId as string).get();
    if (!snap.exists) return problemNotFound('preset not found');

    return NextResponse.json(serializePreset(snap.id, snap.data() ?? {}));
  } catch (err) {
    return problemFromError(err, 'platform/system-presets/[presetId]:GET');
  }
});

interface PatchBody {
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

export const PATCH = authorizedPlatformHandler<RouteParams>({
  capability: 'SYSTEM_PRESET_MANAGE',
  targetKind: 'preset',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const params = await routeContext!.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PatchBody;

    try {
      await updateSystemPreset(
        { actor: ctx.actor, presetId: presetId as string },
        {
          name: typeof body.name === 'string' ? body.name : undefined,
          software_name:
            typeof body.software_name === 'string' ? body.software_name : undefined,
          category: typeof body.category === 'string' ? body.category : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          icon: typeof body.icon === 'string' ? body.icon : undefined,
          installer_name:
            typeof body.installer_name === 'string' ? body.installer_name : undefined,
          installer_url:
            typeof body.installer_url === 'string' ? body.installer_url : undefined,
          silent_flags:
            typeof body.silent_flags === 'string' ? body.silent_flags : undefined,
          verify_path: typeof body.verify_path === 'string' ? body.verify_path : undefined,
          close_processes: Array.isArray(body.close_processes)
            ? (body.close_processes as unknown[]).filter((p): p is string => typeof p === 'string')
            : undefined,
          parallel_install:
            typeof body.parallel_install === 'boolean' ? body.parallel_install : undefined,
          is_owlette_agent:
            typeof body.is_owlette_agent === 'boolean' ? body.is_owlette_agent : undefined,
          timeout_seconds:
            typeof body.timeout_seconds === 'number' ? body.timeout_seconds : undefined,
          order: typeof body.order === 'number' ? body.order : undefined,
        },
      );
      return NextResponse.json({ presetId });
    } catch (err) {
      if (err instanceof SystemPresetNotFoundError) {
        return problemNotFound('preset not found');
      }
      if (err instanceof SystemPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'platform/system-presets/[presetId]:PATCH');
  }
});

export const DELETE = authorizedPlatformHandler<RouteParams>({
  capability: 'SYSTEM_PRESET_MANAGE',
  targetKind: 'preset',
})(async (_request, ctx, routeContext) => {
  try {
    const params = await routeContext!.params;
    const presetId = params.presetId;
    const idError = validatePresetId(presetId);
    if (idError) return idError;

    try {
      await deleteSystemPreset({ actor: ctx.actor, presetId: presetId as string });
      return new NextResponse(null, { status: 204 });
    } catch (err) {
      if (err instanceof SystemPresetValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'platform/system-presets/[presetId]:DELETE');
  }
});

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
