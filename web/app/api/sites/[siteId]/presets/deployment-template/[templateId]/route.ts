/**
 * GET    /api/sites/{siteId}/presets/deployment-template/{templateId}
 * PATCH  /api/sites/{siteId}/presets/deployment-template/{templateId}
 * DELETE /api/sites/{siteId}/presets/deployment-template/{templateId}
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
import { DeploymentTemplateValidationError } from '@/lib/actions/createDeploymentTemplate.server';
import {
  updateDeploymentTemplate,
  DeploymentTemplateNotFoundError,
  type UpdateDeploymentTemplateInput,
} from '@/lib/actions/updateDeploymentTemplate.server';
import { deleteDeploymentTemplate } from '@/lib/actions/deleteDeploymentTemplate.server';

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface RouteParams {
  params: Promise<{ siteId: string; templateId: string }>;
}

export const GET = authorizedSiteHandler<{ siteId: string; templateId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { templateId } = await routeContext.params;
    if (!TEMPLATE_ID_RE.test(templateId)) {
      return problemValidation('invalid template id', {
        templateId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      });
    }

    const db = getAdminDb();
    const tplSnap = await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('installer_templates')
      .doc(templateId)
      .get();

    if (!tplSnap.exists) return problemNotFound('deployment template not found');
    const data = tplSnap.data() ?? {};
    return NextResponse.json({
      id: templateId,
      name: typeof data.name === 'string' ? data.name : 'Unnamed Template',
      installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
      installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
      silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
      verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
      close_processes: Array.isArray(data.close_processes) ? data.close_processes : null,
      parallel_install: data.parallel_install === true,
      createdAt: timestampToIso(data.createdAt),
      updatedAt: timestampToIso(data.updatedAt),
    });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/presets/deployment-template/[templateId]:GET');
  }
});

export const PATCH = authorizedSiteHandler<{ siteId: string; templateId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { templateId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as UpdateDeploymentTemplateInput;

    const result = await updateDeploymentTemplate(ctx, templateId, body);
    return NextResponse.json({ templateId: result.templateId, siteId: result.siteId });
  } catch (err) {
    if (err instanceof DeploymentTemplateValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof DeploymentTemplateNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/deployment-template/[templateId]:PATCH');
  }
});

export const DELETE = authorizedSiteHandler<{ siteId: string; templateId: string }>({
  capability: 'PRESET_MANAGE',
  siteIdParam: 'path',
  targetKind: 'preset',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteParams) => {
  try {
    const { templateId } = await routeContext.params;
    await deleteDeploymentTemplate(ctx, templateId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof DeploymentTemplateValidationError) {
      return problemValidation(err.message, { [err.field]: [err.message] });
    }
    if (err instanceof DeploymentTemplateNotFoundError) {
      return problemNotFound(err.message);
    }
    return problemFromError(err, 'sites/[siteId]/presets/deployment-template/[templateId]:DELETE');
  }
});
