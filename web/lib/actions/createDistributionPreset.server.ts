/**
 * Writes `config/{siteId}/project_distribution_presets/{presetId}`.
 *
 * Custom presets ONLY — id is slug+timestamp so same-named presets can't
 * collide. Built-in overrides use a deterministic `builtin-*` id and go through
 * updateDistributionPreset instead.
 *
 * Field shape must stay identical to `useProjectDistributionPresets.ts`.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { UserActor } from '@/lib/capabilities';

export interface CreateDistributionPresetInput {
  name: string;
  description?: string;
  project_url?: string;
  extract_path?: string;
  verify_files?: string[];
  order: number;
  isBuiltIn?: boolean;
}

export interface CreateDistributionPresetContext {
  actor: UserActor;
  siteId: string;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
}

export interface CreateDistributionPresetResult {
  presetId: string;
}

export class DistributionPresetValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'DistributionPresetValidationError';
    this.field = field;
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Firestore rejects undefined; blank optional preset fields arrive as such. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export async function createDistributionPreset(
  ctx: CreateDistributionPresetContext,
  input: CreateDistributionPresetInput,
): Promise<CreateDistributionPresetResult> {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new DistributionPresetValidationError('name', 'name is required and must be a non-empty string');
  }
  if (input.name.length > 100) {
    throw new DistributionPresetValidationError('name', 'name must be 100 chars or fewer');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new DistributionPresetValidationError('description', 'description must be a string');
  }
  if (input.project_url !== undefined && typeof input.project_url !== 'string') {
    throw new DistributionPresetValidationError('project_url', 'project_url must be a string');
  }
  if (input.extract_path !== undefined && typeof input.extract_path !== 'string') {
    throw new DistributionPresetValidationError('extract_path', 'extract_path must be a string');
  }
  if (input.verify_files !== undefined) {
    if (!Array.isArray(input.verify_files) || input.verify_files.some((f) => typeof f !== 'string')) {
      throw new DistributionPresetValidationError('verify_files', 'verify_files must be an array of strings');
    }
  }
  if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
    throw new DistributionPresetValidationError('order', 'order must be a finite number');
  }

  const slug = slugify(input.name);
  if (!slug) {
    throw new DistributionPresetValidationError(
      'name',
      'name must contain at least one alphanumeric character',
    );
  }

  const presetId = `projdist-${slug}-${Date.now()}`;
  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('project_distribution_presets')
    .doc(presetId);

  const payload = stripUndefined({
    name: input.name.trim(),
    description: input.description,
    project_url: input.project_url,
    extract_path: input.extract_path,
    verify_files: input.verify_files,
    order: input.order,
    isBuiltIn: input.isBuiltIn === true,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  });

  await presetRef.set(payload);

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: presetId,
    attributes: {
      verb: 'preset.create',
      endpoint: 'presets/distribution',
      method: 'POST',
      family: 'distribution',
      presetId,
      isBuiltIn: input.isBuiltIn === true,
    },
  });

  return { presetId };
}
