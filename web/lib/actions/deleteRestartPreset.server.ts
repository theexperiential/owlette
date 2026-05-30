/**
 * deleteRestartPreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useRestartPresets:deletePreset` (web/hooks/useRestartPresets.ts).
 * Missing docs are treated as success, matching firebase client deleteDoc behavior.
 * The `reboot_presets` collection name is a storage contract (legacy spelling).
 */
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { RestartPresetValidationError } from './createRestartPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DeleteRestartPresetResult {
  presetId: string;
  siteId: string;
}

export async function deleteRestartPreset(
  ctx: SiteHandlerContext,
  presetId: string,
): Promise<DeleteRestartPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new RestartPresetValidationError('presetId', 'invalid preset id');
  }

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('reboot_presets')
    .doc(presetId);

  await presetRef.delete();
  return { presetId, siteId: ctx.siteId };
}
