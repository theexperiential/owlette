/**
 * deleteSchedulePreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useSchedulePresets:deletePreset` (web/hooks/useSchedulePresets.ts:173-178).
 * Pure firestore deleteDoc against `config/{siteId}/schedule_presets/{presetId}`.
 *
 * Deleting a built-in override removes the override and causes the hook to
 * re-merge the hardcoded default on next snapshot. Missing docs are treated
 * as success, matching firebase client deleteDoc behavior.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { SchedulePresetValidationError } from './createSchedulePreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DeleteSchedulePresetResult {
  presetId: string;
  siteId: string;
}

export async function deleteSchedulePreset(
  ctx: SiteHandlerContext,
  presetId: string,
): Promise<DeleteSchedulePresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new SchedulePresetValidationError('presetId', 'invalid preset id');
  }

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('schedule_presets')
    .doc(presetId);

  await presetRef.delete();
  return { presetId, siteId: ctx.siteId };
}
