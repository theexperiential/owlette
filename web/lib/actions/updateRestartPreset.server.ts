/**
 * updateRestartPreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useRestartPresets:updatePreset` (web/hooks/useRestartPresets.ts).
 * Same built-in vs custom split as schedule presets. The `reboot_presets`
 * collection name is a storage contract and keeps the legacy spelling.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import {
  RestartPresetValidationError,
  validateRestartPresetInput,
  type CreateRestartPresetInput,
} from './createRestartPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type UpdateRestartPresetInput = Partial<Omit<CreateRestartPresetInput, 'createdBy'>>;

export interface UpdateRestartPresetResult {
  presetId: string;
  siteId: string;
  isBuiltInOverride: boolean;
}

export class RestartPresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`restart preset not found: ${presetId}`);
    this.name = 'RestartPresetNotFoundError';
  }
}

function hasRestartPresetUpdate(updates: UpdateRestartPresetInput): boolean {
  return (
    updates.name !== undefined ||
    updates.description !== undefined ||
    updates.enabled !== undefined ||
    updates.entries !== undefined ||
    updates.isBuiltIn !== undefined ||
    updates.order !== undefined
  );
}

export async function updateRestartPreset(
  ctx: SiteHandlerContext,
  presetId: string,
  updates: UpdateRestartPresetInput,
): Promise<UpdateRestartPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new RestartPresetValidationError('presetId', 'invalid preset id');
  }
  if (!updates || !hasRestartPresetUpdate(updates)) {
    throw new RestartPresetValidationError('body', 'no updatable fields supplied');
  }
  validateRestartPresetInput(updates, { allowPartial: true });

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('reboot_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof updates.name === 'string') payload.name = updates.name.trim();
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.enabled !== undefined) payload.enabled = updates.enabled;
  if (updates.entries !== undefined) payload.entries = updates.entries;
  if (updates.isBuiltIn !== undefined) payload.isBuiltIn = updates.isBuiltIn;
  if (updates.order !== undefined) payload.order = updates.order;

  if (presetId.startsWith('builtin-')) {
    payload.isBuiltIn = true;
    await presetRef.set(payload, { merge: true });
    return { presetId, siteId: ctx.siteId, isBuiltInOverride: true };
  }

  const existing = await presetRef.get();
  if (!existing.exists) throw new RestartPresetNotFoundError(presetId);
  await presetRef.update(payload);
  return { presetId, siteId: ctx.siteId, isBuiltInOverride: false };
}
