/**
 * deleteTalonPreset action core — reusable talon templates.
 *
 * Missing docs are treated as success, matching the other preset families and
 * the firebase client's `deleteDoc` behaviour. Deleting a `builtin-*` id just
 * removes the site's override, so the shipped default reappears.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { siteAuditActor } from './auditActor.server';
import { TalonPresetValidationError } from './createTalonPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface DeleteTalonPresetResult {
  presetId: string;
  siteId: string;
}

export async function deleteTalonPreset(
  ctx: SiteHandlerContext,
  presetId: string,
): Promise<DeleteTalonPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new TalonPresetValidationError('presetId', 'invalid preset id');
  }

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('talon_presets')
    .doc(presetId);

  await presetRef.delete();

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: siteAuditActor(ctx),
    targetId: presetId,
    attributes: {
      verb: 'preset.delete',
      endpoint: 'presets/talon',
      method: 'DELETE',
      family: 'talon',
      presetId,
    },
  });

  return { presetId, siteId: ctx.siteId };
}
