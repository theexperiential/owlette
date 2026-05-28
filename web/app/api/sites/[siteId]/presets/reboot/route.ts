/**
 * GET  /api/sites/{siteId}/presets/reboot
 * POST /api/sites/{siteId}/presets/reboot
 *
 * Capability: PRESET_MANAGE.
 * Firestore path: `config/{siteId}/reboot_presets/{presetId}`.
 *
 * security-boundary-migration wave 3.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { readAndParseJsonBody } from '@/app/api/_shared';
import {
  createRebootPreset,
  RebootPresetValidationError,
  type CreateRebootPresetInput,
} from '@/lib/actions/createRebootPreset.server';

export const GET = authorizedSiteHandler({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const db = getAdminDb();
    const snap = await db
      .collection('config')
      .doc(ctx.siteId)
      .collection('reboot_presets')
      .get();

    const items = snap.docs.map((d) => serializePreset(d.id, d.data() ?? {}));
    return NextResponse.json({ items });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/reboot:GET');
  }
});

export const POST = authorizedSiteHandler({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const body = (parsed.body ?? {}) as Partial<CreateRebootPresetInput>;
    const input: CreateRebootPresetInput = {
      name: body.name as string,
      description: body.description,
      enabled: body.enabled,
      entries: body.entries ?? [],
      isBuiltIn: body.isBuiltIn ?? false,
      order: typeof body.order === 'number' ? body.order : 0,
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : ctx.actor.userId,
    };

    const result = await createRebootPreset(ctx, input);
    return NextResponse.json(
      { presetId: result.presetId, siteId: result.siteId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof RebootPresetValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    return problemFromError(err, 'sites/[siteId]/presets/reboot:POST');
  }
});

function serializePreset(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : null,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : null,
    entries: Array.isArray(data.entries) ? data.entries : [],
    isBuiltIn: data.isBuiltIn === true,
    order: typeof data.order === 'number' ? data.order : 0,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
