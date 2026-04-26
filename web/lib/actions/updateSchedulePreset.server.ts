/**
 * updateSchedulePreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useSchedulePresets:updatePreset` (web/hooks/useSchedulePresets.ts:150-171).
 * Two paths:
 *   - presetId starts with `builtin-`: setDoc({ merge: true }) so the
 *     override doc is created on first edit. Always restamps `isBuiltIn: true`.
 *   - otherwise: updateDoc, after confirming the custom doc exists.
 *
 * Both paths stamp `updatedAt = serverTimestamp()`.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import {
  SchedulePresetValidationError,
  validateSchedulePresetInput,
  type CreateSchedulePresetInput,
} from './createSchedulePreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type UpdateSchedulePresetInput = Partial<Omit<CreateSchedulePresetInput, 'createdBy'>>;

export interface UpdateSchedulePresetResult {
  presetId: string;
  siteId: string;
  /** True when the doc was treated as a built-in override (setDoc + merge). */
  isBuiltInOverride: boolean;
}

export class SchedulePresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`schedule preset not found: ${presetId}`);
    this.name = 'SchedulePresetNotFoundError';
  }
}

function hasSchedulePresetUpdate(updates: UpdateSchedulePresetInput): boolean {
  return (
    updates.name !== undefined ||
    updates.description !== undefined ||
    updates.blocks !== undefined ||
    updates.isBuiltIn !== undefined ||
    updates.order !== undefined
  );
}

export async function updateSchedulePreset(
  ctx: SiteHandlerContext,
  presetId: string,
  updates: UpdateSchedulePresetInput,
): Promise<UpdateSchedulePresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new SchedulePresetValidationError('presetId', 'invalid preset id');
  }
  if (!updates || !hasSchedulePresetUpdate(updates)) {
    throw new SchedulePresetValidationError('body', 'no updatable fields supplied');
  }
  validateSchedulePresetInput(updates, { allowPartial: true });

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('schedule_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof updates.name === 'string') payload.name = updates.name.trim();
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.blocks !== undefined) payload.blocks = updates.blocks;
  if (updates.isBuiltIn !== undefined) payload.isBuiltIn = updates.isBuiltIn;
  if (updates.order !== undefined) payload.order = updates.order;

  if (presetId.startsWith('builtin-')) {
    payload.isBuiltIn = true;
    await presetRef.set(payload, { merge: true });
    return { presetId, siteId: ctx.siteId, isBuiltInOverride: true };
  }

  const existing = await presetRef.get();
  if (!existing.exists) throw new SchedulePresetNotFoundError(presetId);
  await presetRef.update(payload);
  return { presetId, siteId: ctx.siteId, isBuiltInOverride: false };
}
