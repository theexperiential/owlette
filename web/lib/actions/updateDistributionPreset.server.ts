/**
 * updateDistributionPreset action core
 *
 * security-boundary-migration wave 3.7. mirrors the schedule/reboot preset
 * pattern (wave 3.6) — only the firestore path differs.
 *
 * firestore path: `config/{siteId}/project_distribution_presets/{presetId}`
 *
 * Two write paths, mirroring the original `useProjectDistributionPresets`
 * hook:
 *
 *   1. Built-in override (`presetId.startsWith('builtin-')`) — `set()` with
 *      `merge: true` so the override doc is created on first edit. Forces
 *      `isBuiltIn: true` regardless of caller input so the merge can't
 *      accidentally promote a built-in to a custom.
 *   2. Custom edit — `update()` (fails if doc doesn't exist, which is the
 *      desired safety: edits should not silently create a new preset).
 *
 * Both paths stamp `updatedAt` with a server timestamp.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
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

  // ── validation (only validate provided fields — partial update) ─────────
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

  if (ctx.presetId.startsWith('builtin-')) {
    // Built-in override: setDoc with merge so it creates the override doc on
    // first edit. Force isBuiltIn=true so a malformed merge can't promote.
    await presetRef.set(
      {
        ...cleanUpdates,
        isBuiltIn: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return;
  }

  // Custom edit: update() fails if the doc is missing — desired safety so
  // we don't silently create new presets via PATCH.
  try {
    await presetRef.update({
      ...cleanUpdates,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // firebase-admin throws { code: 5, ... } for NOT_FOUND on update().
    const code = (err as { code?: number | string } | null)?.code;
    if (code === 5 || code === 'not-found') {
      throw new DistributionPresetNotFoundError(ctx.presetId);
    }
    throw err;
  }
}
