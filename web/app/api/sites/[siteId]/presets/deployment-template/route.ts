/**
 * GET  /api/sites/{siteId}/presets/deployment-template
 * POST /api/sites/{siteId}/presets/deployment-template
 *
 * Capability: PRESET_MANAGE.
 * Firestore path: `sites/{siteId}/installer_templates/{templateId}`.
 *
 * Note: deployment templates use a different firestore path from
 * schedule + reboot presets — they live under `sites/{siteId}` rather
 * than `config/{siteId}` to match the existing client hook
 * (`useDeployments.ts:89`). They also have no built-in/custom split.
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
  createDeploymentTemplate,
  DeploymentTemplateValidationError,
  type CreateDeploymentTemplateInput,
} from '@/lib/actions/createDeploymentTemplate.server';

export const GET = authorizedSiteHandler({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const db = getAdminDb();
    const snap = await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('installer_templates')
      .get();

    const items = snap.docs.map((d) => serializeTemplate(d.id, d.data() ?? {}));
    return NextResponse.json({ items });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/deployment-template:GET');
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

    const body = (parsed.body ?? {}) as Partial<CreateDeploymentTemplateInput>;
    const input: CreateDeploymentTemplateInput = {
      name: body.name as string,
      installer_name: body.installer_name as string,
      installer_url: body.installer_url as string,
      silent_flags: body.silent_flags as string,
      verify_path: body.verify_path,
      close_processes: body.close_processes,
      parallel_install: body.parallel_install,
    };

    const result = await createDeploymentTemplate(ctx, input);
    return NextResponse.json(
      { templateId: result.templateId, siteId: result.siteId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DeploymentTemplateValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    return problemFromError(err, 'sites/[siteId]/presets/deployment-template:POST');
  }
});

function serializeTemplate(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Unnamed Template',
    installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
    installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
    silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
    verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
    close_processes: Array.isArray(data.close_processes) ? data.close_processes : null,
    parallel_install: data.parallel_install === true,
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
