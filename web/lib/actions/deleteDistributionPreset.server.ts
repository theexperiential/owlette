/**
 * deleteDistributionPreset action core
 *
 * security-boundary-migration wave 3.7. mirrors the schedule/reboot preset
 * pattern (wave 3.6) — only the firestore path differs.
 *
 * firestore path: `config/{siteId}/project_distribution_presets/{presetId}`
 *
 * Deleting a `builtin-*` preset removes the override doc — the hardcoded
 * default re-emerges on the next read. Deleting a custom preset removes it
 * permanently. Either way, this is a hard delete; there is no soft-delete
 * pattern for presets in the original hook.
 *
 * Returns silently if the doc doesn't exist (firebase-admin `delete()` is
 * idempotent), matching the original hook's behaviour.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import { DistributionPresetValidationError } from './createDistributionPreset.server';

export interface DeleteDistributionPresetContext {
  actor: UserActor;
  siteId: string;
  presetId: string;
}

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function deleteDistributionPreset(
  ctx: DeleteDistributionPresetContext,
): Promise<void> {
  if (!PRESET_ID_RE.test(ctx.presetId)) {
    throw new DistributionPresetValidationError(
      'presetId',
      'presetId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('project_distribution_presets')
    .doc(ctx.presetId);

  await presetRef.delete();
}
