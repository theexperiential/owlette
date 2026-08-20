/**
 * GET / POST /api/sites/{siteId}/presets/talon — `config/{siteId}/talon_presets/{presetId}`.
 *
 * Capability is PRESET_MANAGE, deliberately NOT `TALON_MANAGE`: presets edit
 * stored config and never reach a machine, a talon template included.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { readAndParseJsonBody } from '@/app/api/_shared';
import {
  createTalonPreset,
  TalonPresetValidationError,
  type CreateTalonPresetInput,
} from '@/lib/actions/createTalonPreset.server';

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
      .collection('talon_presets')
      .get();

    const items = snap.docs.map((d) => serializeTalonPreset(d.id, d.data() ?? {}));
    return NextResponse.json({ items });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/talon:GET');
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

    const body = (parsed.body ?? {}) as Partial<CreateTalonPresetInput>;
    const input: CreateTalonPresetInput = {
      name: body.name as string,
      description: body.description,
      template: body.template,
      isBuiltIn: body.isBuiltIn ?? false,
      order: typeof body.order === 'number' ? body.order : 0,
      // Accepted for shape parity with the other families; the action core
      // overrides it with the authenticated actor.
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : ctx.actor.userId,
    };

    const result = await createTalonPreset(ctx, input);
    return NextResponse.json(
      { presetId: result.presetId, siteId: result.siteId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof TalonPresetValidationError) return talonPresetProblem(err);
    return problemFromError(err, 'sites/[siteId]/presets/talon:POST');
  }
});

/**
 * Render a preset rejection. Validator failures carry the whole `template.*`
 * field-error list in both shapes — `errors` for RFC 7807 consumers,
 * `fieldErrors` for the editor's inline routing — as `POST .../talons` does.
 */
export function talonPresetProblem(err: TalonPresetValidationError): NextResponse {
  if (!err.fieldErrors) {
    return problemValidation(err.message, { [err.field]: [err.message] });
  }

  const errors: Record<string, string[]> = {};
  for (const fieldError of err.fieldErrors) {
    (errors[`body.${fieldError.field}`] ??= []).push(fieldError.message);
  }
  return problem({
    type: ProblemType.ValidationFailed,
    title: 'validation failed',
    status: 400,
    detail: err.message,
    errors,
    fieldErrors: err.fieldErrors,
  });
}

export function serializeTalonPreset(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : null,
    template: data.template ?? null,
    isBuiltIn: data.isBuiltIn === true,
    order: typeof data.order === 'number' ? data.order : 0,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
