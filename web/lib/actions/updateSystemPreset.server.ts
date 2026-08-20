/**
 * updateSystemPreset action core, mirroring `useSystemPresets:updatePreset`.
 * Partial update of `system_presets/{presetId}`: only provided fields are
 * written, `updatedAt` gets a server timestamp.
 *
 * `update()`, not `set merge: true`, so PATCHing a missing preset raises
 * `SystemPresetNotFoundError` rather than silently creating one — that's POST.
 *
 * Pure action, no HTTP. Wrapped at the route layer with
 * `authorizedPlatformHandler({ capability: 'SYSTEM_PRESET_MANAGE' })`.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import { SystemPresetValidationError } from './createSystemPreset.server';

export interface UpdateSystemPresetInput {
  name?: string;
  software_name?: string;
  category?: string;
  description?: string;
  icon?: string;
  installer_name?: string;
  installer_url?: string;
  silent_flags?: string;
  verify_path?: string;
  close_processes?: string[];
  parallel_install?: boolean;
  sha256_checksum?: string;
  is_owlette_agent?: boolean;
  timeout_seconds?: number;
  order?: number;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export interface UpdateSystemPresetContext {
  actor: UserActor;
  presetId: string;
}

export class SystemPresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`system preset not found: ${presetId}`);
    this.name = 'SystemPresetNotFoundError';
  }
}

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export async function updateSystemPreset(
  ctx: UpdateSystemPresetContext,
  input: UpdateSystemPresetInput,
): Promise<void> {
  if (!PRESET_ID_RE.test(ctx.presetId)) {
    throw new SystemPresetValidationError(
      'presetId',
      'presetId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }

  // Partial: only provided fields are validated.
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new SystemPresetValidationError('name', 'name must be a non-empty string');
    }
    if (input.name.length > 200) {
      throw new SystemPresetValidationError('name', 'name must be 200 chars or fewer');
    }
  }
  if (input.software_name !== undefined) {
    if (typeof input.software_name !== 'string' || input.software_name.trim().length === 0) {
      throw new SystemPresetValidationError(
        'software_name',
        'software_name must be a non-empty string',
      );
    }
  }
  if (input.category !== undefined) {
    if (typeof input.category !== 'string' || input.category.trim().length === 0) {
      throw new SystemPresetValidationError('category', 'category must be a non-empty string');
    }
  }
  if (input.installer_name !== undefined) {
    if (typeof input.installer_name !== 'string' || input.installer_name.trim().length === 0) {
      throw new SystemPresetValidationError(
        'installer_name',
        'installer_name must be a non-empty string',
      );
    }
  }
  if (input.installer_url !== undefined && typeof input.installer_url !== 'string') {
    throw new SystemPresetValidationError('installer_url', 'installer_url must be a string');
  }
  if (input.silent_flags !== undefined && typeof input.silent_flags !== 'string') {
    throw new SystemPresetValidationError('silent_flags', 'silent_flags must be a string');
  }
  if (input.is_owlette_agent !== undefined && typeof input.is_owlette_agent !== 'boolean') {
    throw new SystemPresetValidationError(
      'is_owlette_agent',
      'is_owlette_agent must be a boolean',
    );
  }
  if (
    input.order !== undefined &&
    (typeof input.order !== 'number' || !Number.isFinite(input.order))
  ) {
    throw new SystemPresetValidationError('order', 'order must be a finite number');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new SystemPresetValidationError('description', 'description must be a string');
  }
  if (input.icon !== undefined && typeof input.icon !== 'string') {
    throw new SystemPresetValidationError('icon', 'icon must be a string');
  }
  if (input.verify_path !== undefined && typeof input.verify_path !== 'string') {
    throw new SystemPresetValidationError('verify_path', 'verify_path must be a string');
  }
  if (input.close_processes !== undefined) {
    if (
      !Array.isArray(input.close_processes) ||
      input.close_processes.some((p) => typeof p !== 'string')
    ) {
      throw new SystemPresetValidationError(
        'close_processes',
        'close_processes must be an array of strings',
      );
    }
  }
  if (input.parallel_install !== undefined && typeof input.parallel_install !== 'boolean') {
    throw new SystemPresetValidationError(
      'parallel_install',
      'parallel_install must be a boolean',
    );
  }
  if (
    input.timeout_seconds !== undefined &&
    (typeof input.timeout_seconds !== 'number' || !Number.isFinite(input.timeout_seconds))
  ) {
    throw new SystemPresetValidationError(
      'timeout_seconds',
      'timeout_seconds must be a finite number',
    );
  }
  if (input.sha256_checksum !== undefined) {
    if (typeof input.sha256_checksum !== 'string' || !SHA256_HEX_RE.test(input.sha256_checksum)) {
      throw new SystemPresetValidationError(
        'sha256_checksum',
        'sha256_checksum must be a 64-character hex SHA-256 hash',
      );
    }
  }

  const db = getAdminDb();
  const presetRef = db.collection('system_presets').doc(ctx.presetId);

  const cleanUpdates = stripUndefined({
    name: input.name?.trim(),
    software_name: input.software_name?.trim(),
    category: input.category?.trim(),
    description: input.description,
    icon: input.icon,
    installer_name: input.installer_name?.trim(),
    installer_url: input.installer_url,
    silent_flags: input.silent_flags,
    verify_path: input.verify_path,
    close_processes: input.close_processes,
    parallel_install: input.parallel_install,
    sha256_checksum: input.sha256_checksum?.toLowerCase(),
    is_owlette_agent: input.is_owlette_agent,
    timeout_seconds: input.timeout_seconds,
    order: input.order,
  });

  try {
    await presetRef.update({
      ...cleanUpdates,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // firebase-admin throws { code: 5, ... } for NOT_FOUND on update().
    const code = (err as { code?: number | string } | null)?.code;
    if (code === 5 || code === 'not-found') {
      throw new SystemPresetNotFoundError(ctx.presetId);
    }
    throw err;
  }
}
