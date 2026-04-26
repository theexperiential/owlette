/**
 * updateDeploymentTemplate action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useDeployments:updateTemplate` (web/hooks/useDeployments.ts:144-149).
 * The hook uses `setDoc({ merge: true })` so partial updates merge into the
 * existing doc, preserving fields the client does not include in the patch.
 *
 * Templates have no built-in/custom split. We still require the doc to exist
 * so a typoed templateId does not silently create a partial doc.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import {
  DeploymentTemplateValidationError,
  validateDeploymentTemplateInput,
  type CreateDeploymentTemplateInput,
} from './createDeploymentTemplate.server';

const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type UpdateDeploymentTemplateInput = Partial<CreateDeploymentTemplateInput>;

export interface UpdateDeploymentTemplateResult {
  templateId: string;
  siteId: string;
}

export class DeploymentTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`deployment template not found: ${templateId}`);
    this.name = 'DeploymentTemplateNotFoundError';
  }
}

function hasDeploymentTemplateUpdate(updates: UpdateDeploymentTemplateInput): boolean {
  return (
    updates.name !== undefined ||
    updates.installer_name !== undefined ||
    updates.installer_url !== undefined ||
    updates.silent_flags !== undefined ||
    updates.verify_path !== undefined ||
    updates.close_processes !== undefined ||
    updates.parallel_install !== undefined
  );
}

export async function updateDeploymentTemplate(
  ctx: SiteHandlerContext,
  templateId: string,
  updates: UpdateDeploymentTemplateInput,
): Promise<UpdateDeploymentTemplateResult> {
  if (typeof templateId !== 'string' || !TEMPLATE_ID_RE.test(templateId)) {
    throw new DeploymentTemplateValidationError('templateId', 'invalid template id');
  }
  if (!updates || !hasDeploymentTemplateUpdate(updates)) {
    throw new DeploymentTemplateValidationError('body', 'no updatable fields supplied');
  }
  validateDeploymentTemplateInput(updates, { allowPartial: true });

  const db = getAdminDb();
  const templateRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('installer_templates')
    .doc(templateId);

  const existing = await templateRef.get();
  if (!existing.exists) throw new DeploymentTemplateNotFoundError(templateId);

  const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof updates.name === 'string') payload.name = updates.name.trim();
  if (typeof updates.installer_name === 'string') payload.installer_name = updates.installer_name.trim();
  if (updates.installer_url !== undefined) payload.installer_url = updates.installer_url;
  if (updates.silent_flags !== undefined) payload.silent_flags = updates.silent_flags;
  if (updates.verify_path !== undefined) payload.verify_path = updates.verify_path;
  if (updates.close_processes !== undefined) payload.close_processes = updates.close_processes;
  if (updates.parallel_install !== undefined) payload.parallel_install = updates.parallel_install;

  await templateRef.set(payload, { merge: true });

  return { templateId, siteId: ctx.siteId };
}
