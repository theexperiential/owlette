/**
 * updateRebootPreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useRebootPresets:updatePreset` (web/hooks/useRebootPresets.ts:144-164).
 * Same built-in vs custom split as schedule presets.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import {
  RebootPresetValidationError,
  validateRebootPresetInput,
  type CreateRebootPresetInput,
} from './createRebootPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type UpdateRebootPresetInput = Partial<Omit<CreateRebootPresetInput, 'createdBy'>>;

export interface UpdateRebootPresetResult {
  presetId: string;
  siteId: string;
  isBuiltInOverride: boolean;
}

export class RebootPresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`reboot preset not found: ${presetId}`);
    this.name = 'RebootPresetNotFoundError';
  }
}

function hasRebootPresetUpdate(updates: UpdateRebootPresetInput): boolean {
  return (
    updates.name !== undefined ||
    updates.description !== undefined ||
    updates.enabled !== undefined ||
    updates.entries !== undefined ||
    updates.isBuiltIn !== undefined ||
    updates.order !== undefined
  );
}

export async function updateRebootPreset(
  ctx: SiteHandlerContext,
  presetId: string,
  updates: UpdateRebootPresetInput,
): Promise<UpdateRebootPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new RebootPresetValidationError('presetId', 'invalid preset id');
  }
  if (!updates || !hasRebootPresetUpdate(updates)) {
    throw new RebootPresetValidationError('body', 'no updatable fields supplied');
  }
  validateRebootPresetInput(updates, { allowPartial: true });

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
  if (!existing.exists) throw new RebootPresetNotFoundError(presetId);
  await presetRef.update(payload);
  return { presetId, siteId: ctx.siteId, isBuiltInOverride: false };
}
