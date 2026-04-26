/**
 * deleteSystemPreset action core (security-boundary-migration wave 3.11).
 *
 * Mirrors `useSystemPresets:deletePreset` (web/hooks/useSystemPresets.ts:167-174).
 * Hard delete — there is no soft-delete pattern for system presets in the
 * original hook.
 *
 * firestore path: `system_presets/{presetId}` (platform-level).
 *
 * Returns silently if the doc doesn't exist (firebase-admin `delete()` is
 * idempotent), matching the original hook's behaviour.
 *
 * Pure action — does not touch HTTP. Wrapped at the route layer with
 * `authorizedPlatformHandler({ capability: 'SYSTEM_PRESET_MANAGE' })`.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import { SystemPresetValidationError } from './createSystemPreset.server';

export interface DeleteSystemPresetContext {
  actor: UserActor;
  presetId: string;
}

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function deleteSystemPreset(
  ctx: DeleteSystemPresetContext,
): Promise<void> {
  if (!PRESET_ID_RE.test(ctx.presetId)) {
    throw new SystemPresetValidationError(
      'presetId',
      'presetId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }

  const db = getAdminDb();
  await db.collection('system_presets').doc(ctx.presetId).delete();
}
