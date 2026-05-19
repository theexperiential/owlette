/**
 * createDeploymentTemplate action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useDeployments:createTemplate` (web/hooks/useDeployments.ts:130-142).
 * Note the different firestore path from the other preset types:
 * `sites/{siteId}/installer_templates/{templateId}` (not under `config/{siteId}`).
 *
 * Templates do NOT have a built-in/custom distinction — they are all
 * user-created. The route uses `setDoc` (no merge) for create.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

export interface CreateDeploymentTemplateInput {
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];
  parallel_install?: boolean;
}

export interface CreateDeploymentTemplateResult {
  templateId: string;
  siteId: string;
}

export class DeploymentTemplateValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'DeploymentTemplateValidationError';
  }
}

export function validateDeploymentTemplateInput(
  input: Partial<CreateDeploymentTemplateInput>,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): void {
  if (!allowPartial || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new DeploymentTemplateValidationError('name', 'name is required and must be a non-empty string');
    }
  }
  if (!allowPartial || input.installer_name !== undefined) {
    if (typeof input.installer_name !== 'string' || input.installer_name.trim().length === 0) {
      throw new DeploymentTemplateValidationError(
        'installer_name',
        'installer_name is required and must be a non-empty string',
      );
    }
  }
  if (!allowPartial || input.installer_url !== undefined) {
    if (typeof input.installer_url !== 'string' || input.installer_url.trim().length === 0) {
      throw new DeploymentTemplateValidationError(
        'installer_url',
        'installer_url is required and must be a non-empty string',
      );
    }
    try {
      const u = new URL(input.installer_url);
      if (u.protocol !== 'https:') {
        throw new DeploymentTemplateValidationError('installer_url', 'installer_url must use https://');
      }
    } catch (err) {
      if (err instanceof DeploymentTemplateValidationError) throw err;
      throw new DeploymentTemplateValidationError('installer_url', 'installer_url must be a valid url');
    }
  }
  if (!allowPartial || input.silent_flags !== undefined) {
    if (typeof input.silent_flags !== 'string') {
      throw new DeploymentTemplateValidationError('silent_flags', 'silent_flags is required and must be a string');
    }
  }
  if (input.verify_path !== undefined && input.verify_path !== null) {
    if (typeof input.verify_path !== 'string') {
      throw new DeploymentTemplateValidationError('verify_path', 'verify_path must be a string when provided');
    }
  }
  if (input.close_processes !== undefined) {
    if (
      !Array.isArray(input.close_processes) ||
      input.close_processes.some((p) => typeof p !== 'string')
    ) {
      throw new DeploymentTemplateValidationError('close_processes', 'close_processes must be an array of strings');
    }
  }
  if (input.parallel_install !== undefined && typeof input.parallel_install !== 'boolean') {
    throw new DeploymentTemplateValidationError('parallel_install', 'parallel_install must be a boolean');
  }
}

/**
 * Mirrors useDeployments.ts:133 — `template-{epochMs}`.
 */
function generateTemplateId(): string {
  return `template-${Date.now()}`;
}

export async function createDeploymentTemplate(
  ctx: SiteHandlerContext,
  input: CreateDeploymentTemplateInput,
): Promise<CreateDeploymentTemplateResult> {
  validateDeploymentTemplateInput(input);

  const db = getAdminDb();
  const templateId = generateTemplateId();
  const templateRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('installer_templates')
    .doc(templateId);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    installer_name: input.installer_name.trim(),
    installer_url: input.installer_url,
    silent_flags: input.silent_flags,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.verify_path !== undefined && input.verify_path !== null) {
    payload.verify_path = input.verify_path;
  }
  if (input.close_processes !== undefined) payload.close_processes = input.close_processes;
  if (input.parallel_install !== undefined) payload.parallel_install = input.parallel_install;

  await templateRef.set(payload);

  return { templateId, siteId: ctx.siteId };
}
