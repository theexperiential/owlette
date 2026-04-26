/**
 * createSystemPreset action core (security-boundary-migration wave 3.11).
 *
 * Mirrors `useSystemPresets:createPreset` (web/hooks/useSystemPresets.ts:126-143):
 * generates a deterministic preset id from `software_name` + epoch, writes
 * the doc to `system_presets/{presetId}`, and stamps `createdAt` with a
 * server timestamp.
 *
 * firestore path: `system_presets/{presetId}` (platform-level — NOT
 * site-scoped, despite the surface similarity to schedule/distribution
 * presets which live under `config/{siteId}/...`).
 *
 * Pure action — does not touch HTTP. The route shim wraps this with
 * `authorizedPlatformHandler({ capability: 'SYSTEM_PRESET_MANAGE' })`.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';

export interface CreateSystemPresetInput {
  name: string;
  software_name: string;
  category: string;
  description?: string;
  icon?: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];
  parallel_install?: boolean;
  is_owlette_agent: boolean;
  timeout_seconds?: number;
  order: number;
}

export interface CreateSystemPresetContext {
  actor: UserActor;
}

export interface CreateSystemPresetResult {
  presetId: string;
}

export class SystemPresetValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'SystemPresetValidationError';
    this.field = field;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Strip undefined values from an object. Firestore rejects undefined field
 * values; optional system-preset fields (description, icon, verify_path,
 * close_processes, parallel_install, timeout_seconds) come through as
 * undefined when the caller leaves them blank.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export async function createSystemPreset(
  ctx: CreateSystemPresetContext,
  input: CreateSystemPresetInput,
): Promise<CreateSystemPresetResult> {
  // ── validation ──────────────────────────────────────────────────────────
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new SystemPresetValidationError('name', 'name is required and must be a non-empty string');
  }
  if (input.name.length > 200) {
    throw new SystemPresetValidationError('name', 'name must be 200 chars or fewer');
  }
  if (typeof input.software_name !== 'string' || input.software_name.trim().length === 0) {
    throw new SystemPresetValidationError(
      'software_name',
      'software_name is required and must be a non-empty string',
    );
  }
  if (typeof input.category !== 'string' || input.category.trim().length === 0) {
    throw new SystemPresetValidationError(
      'category',
      'category is required and must be a non-empty string',
    );
  }
  if (typeof input.installer_name !== 'string' || input.installer_name.trim().length === 0) {
    throw new SystemPresetValidationError(
      'installer_name',
      'installer_name is required and must be a non-empty string',
    );
  }
  if (typeof input.installer_url !== 'string') {
    throw new SystemPresetValidationError('installer_url', 'installer_url must be a string');
  }
  if (typeof input.silent_flags !== 'string') {
    throw new SystemPresetValidationError('silent_flags', 'silent_flags must be a string');
  }
  if (typeof input.is_owlette_agent !== 'boolean') {
    throw new SystemPresetValidationError(
      'is_owlette_agent',
      'is_owlette_agent is required and must be a boolean',
    );
  }
  if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
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

  const slug = slugify(input.software_name);
  if (!slug) {
    throw new SystemPresetValidationError(
      'software_name',
      'software_name must contain at least one alphanumeric character',
    );
  }

  // ── firestore write ─────────────────────────────────────────────────────
  // ID convention mirrors useSystemPresets.ts:134 — `preset-{slug}-{epochMs}`.
  const presetId = `preset-${slug}-${Date.now()}`;
  const db = getAdminDb();
  const presetRef = db.collection('system_presets').doc(presetId);

  const payload = stripUndefined({
    name: input.name.trim(),
    software_name: input.software_name.trim(),
    category: input.category.trim(),
    description: input.description,
    icon: input.icon,
    installer_name: input.installer_name.trim(),
    installer_url: input.installer_url,
    silent_flags: input.silent_flags,
    verify_path: input.verify_path,
    close_processes: input.close_processes,
    parallel_install: input.parallel_install,
    is_owlette_agent: input.is_owlette_agent,
    timeout_seconds: input.timeout_seconds,
    order: input.order,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  });

  await presetRef.set(payload);

  return { presetId };
}
