/**
 * deleteDeploymentTemplate action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useDeployments:deleteTemplate` (web/hooks/useDeployments.ts:151-156).
 * Missing docs are treated as success, matching firebase client deleteDoc behavior.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { siteAuditActor } from './auditActor.server';
import { DeploymentTemplateValidationError } from './createDeploymentTemplate.server';

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DeleteDeploymentTemplateResult {
  templateId: string;
  siteId: string;
}

export async function deleteDeploymentTemplate(
  ctx: SiteHandlerContext,
  templateId: string,
): Promise<DeleteDeploymentTemplateResult> {
  if (typeof templateId !== 'string' || !TEMPLATE_ID_RE.test(templateId)) {
    throw new DeploymentTemplateValidationError('templateId', 'invalid template id');
  }

  const db = getAdminDb();
  const templateRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('installer_templates')
    .doc(templateId);

  await templateRef.delete();

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: siteAuditActor(ctx),
    targetId: templateId,
    attributes: {
      verb: 'preset.delete',
      endpoint: 'presets/deployment-template',
      method: 'DELETE',
      family: 'deployment-template',
      presetId: templateId,
    },
  });

  return { templateId, siteId: ctx.siteId };
}
