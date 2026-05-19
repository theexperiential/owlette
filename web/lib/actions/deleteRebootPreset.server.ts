/**
 * deleteRebootPreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useRebootPresets:deletePreset` (web/hooks/useRebootPresets.ts:166-171).
 * Missing docs are treated as success, matching firebase client deleteDoc behavior.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { RebootPresetValidationError } from './createRebootPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DeleteRebootPresetResult {
  presetId: string;
  siteId: string;
}

export async function deleteRebootPreset(
  ctx: SiteHandlerContext,
  presetId: string,
): Promise<DeleteRebootPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new RebootPresetValidationError('presetId', 'invalid preset id');
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
