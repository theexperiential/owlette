/**
 * deleteDistributionPreset action core — same pattern as the schedule/reboot
 * preset actions, only the path differs:
 * `config/{siteId}/project_distribution_presets/{presetId}`.
 *
 * Hard delete, no soft-delete for presets. Deleting a `builtin-*` preset removes
 * only the override doc, so the hardcoded default re-emerges on the next read;
 * a custom preset is gone permanently. A missing doc is a silent no-op
 * (firebase-admin `delete()` is idempotent).
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { UserActor } from '@/lib/capabilities';
import { DistributionPresetValidationError } from './createDistributionPreset.server';

export interface DeleteDistributionPresetContext {
  actor: UserActor;
  siteId: string;
  presetId: string;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
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

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.presetId,
    attributes: {
      verb: 'preset.delete',
      endpoint: 'presets/distribution',
      method: 'DELETE',
      family: 'distribution',
      presetId: ctx.presetId,
    },
  });
}
