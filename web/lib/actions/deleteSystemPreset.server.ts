/**
 * deleteSystemPreset action core. Mirrors `useSystemPresets:deletePreset`
 * (web/hooks/useSystemPresets.ts:167-174): a HARD delete of
 * `system_presets/{presetId}` — system presets have no soft-delete path.
 *
 * Silently succeeds on a missing doc (firebase-admin `delete()` is idempotent),
 * matching the hook. Pure action, no HTTP; the route wraps it with
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
