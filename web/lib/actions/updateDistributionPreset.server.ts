/**
 * Writes `config/{siteId}/project_distribution_presets/{presetId}`
 * (security-boundary-migration wave 3.7; same pattern as the schedule presets in
 * 3.6, different path).
 *
 * Two paths: a `builtin-` id merges via set() so the override doc appears on
 * first edit, forcing `isBuiltIn: true` so a merge can't promote it; anything
 * else uses update(), which fails on a missing doc so an edit can't silently
 * create a preset. Both stamp `updatedAt`.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { UserActor } from '@/lib/capabilities';
import { DistributionPresetValidationError } from './createDistributionPreset.server';

export interface UpdateDistributionPresetInput {
  name?: string;
  description?: string;
  project_url?: string;
  extract_path?: string;
  verify_files?: string[];
  order?: number;
}

export interface UpdateDistributionPresetContext {
  actor: UserActor;
  siteId: string;
  presetId: string;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
}

export class DistributionPresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`distribution preset not found: ${presetId}`);
    this.name = 'DistributionPresetNotFoundError';
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function updateDistributionPreset(
  ctx: UpdateDistributionPresetContext,
  input: UpdateDistributionPresetInput,
): Promise<void> {
  if (!PRESET_ID_RE.test(ctx.presetId)) {
    throw new DistributionPresetValidationError(
      'presetId',
      'presetId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }

  // partial update: only validate the fields present
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new DistributionPresetValidationError('name', 'name must be a non-empty string');
    }
    if (input.name.length > 100) {
      throw new DistributionPresetValidationError('name', 'name must be 100 chars or fewer');
    }
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
  if (input.order !== undefined && (typeof input.order !== 'number' || !Number.isFinite(input.order))) {
    throw new DistributionPresetValidationError('order', 'order must be a finite number');
  }

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('project_distribution_presets')
    .doc(ctx.presetId);

  const cleanUpdates = stripUndefined({
    name: input.name?.trim(),
    description: input.description,
    project_url: input.project_url,
    extract_path: input.extract_path,
    verify_files: input.verify_files,
    order: input.order,
  });

  const emitUpdated = (isBuiltInOverride: boolean) =>
    emitMutation({
      kind: 'process_mutated',
      siteId: ctx.siteId,
      actor: ctx.auditActor,
      targetId: ctx.presetId,
      attributes: {
        verb: 'preset.update',
        endpoint: 'presets/distribution',
        method: 'PATCH',
        family: 'distribution',
        presetId: ctx.presetId,
        isBuiltInOverride,
        fields: Object.keys(cleanUpdates),
      },
    });

  if (ctx.presetId.startsWith('builtin-')) {
    // merge creates the override doc on first edit; isBuiltIn forced so it can't promote
    await presetRef.set(
      {
        ...cleanUpdates,
        isBuiltIn: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    emitUpdated(true);
    return;
  }

  // update() fails on a missing doc, so PATCH can't create a preset
  try {
    await presetRef.update({
      ...cleanUpdates,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // firebase-admin reports NOT_FOUND on update() as code 5
    const code = (err as { code?: number | string } | null)?.code;
    if (code === 5 || code === 'not-found') {
      throw new DistributionPresetNotFoundError(ctx.presetId);
    }
    throw err;
  }

  emitUpdated(false);
}
