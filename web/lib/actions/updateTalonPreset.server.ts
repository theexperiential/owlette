/**
 * updateTalonPreset action core — reusable talon templates.
 *
 * Same built-in vs custom split as the other preset families: a `builtin-*` id
 * is set-with-merge (creating the override doc on first edit) with `isBuiltIn`
 * forced true, and any other id must already exist.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { siteAuditActor } from './auditActor.server';
import {
  TalonPresetValidationError,
  validateTalonPresetFields,
  type CreateTalonPresetInput,
} from './createTalonPreset.server';

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type UpdateTalonPresetInput = Partial<Omit<CreateTalonPresetInput, 'createdBy'>>;

export interface UpdateTalonPresetResult {
  presetId: string;
  siteId: string;
  isBuiltInOverride: boolean;
}

export class TalonPresetNotFoundError extends Error {
  constructor(presetId: string) {
    super(`talon preset not found: ${presetId}`);
    this.name = 'TalonPresetNotFoundError';
  }
}

function hasTalonPresetUpdate(updates: UpdateTalonPresetInput): boolean {
  return (
    updates.name !== undefined ||
    updates.description !== undefined ||
    updates.template !== undefined ||
    updates.isBuiltIn !== undefined ||
    updates.order !== undefined
  );
}

export async function updateTalonPreset(
  ctx: SiteHandlerContext,
  presetId: string,
  updates: UpdateTalonPresetInput,
): Promise<UpdateTalonPresetResult> {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new TalonPresetValidationError('presetId', 'invalid preset id');
  }
  if (!updates || !hasTalonPresetUpdate(updates)) {
    throw new TalonPresetValidationError('body', 'no updatable fields supplied');
  }
  const template = validateTalonPresetFields(updates, { allowPartial: true });

  const db = getAdminDb();
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('talon_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof updates.name === 'string') payload.name = updates.name.trim();
  if (updates.description !== undefined) payload.description = updates.description;
  // The validator's normalized output, never the raw body — the same rule the
  // talon store follows.
  if (template !== undefined) payload.template = template;
  if (updates.isBuiltIn !== undefined) payload.isBuiltIn = updates.isBuiltIn;
  if (updates.order !== undefined) payload.order = updates.order;

  const emitUpdated = (isBuiltInOverride: boolean) =>
    emitMutation({
      kind: 'process_mutated',
      siteId: ctx.siteId,
      actor: siteAuditActor(ctx),
      targetId: presetId,
      attributes: {
        verb: 'preset.update',
        endpoint: 'presets/talon',
        method: 'PATCH',
        family: 'talon',
        presetId,
        isBuiltInOverride,
        fields: Object.keys(payload).filter((k) => k !== 'updatedAt'),
      },
    });

  if (presetId.startsWith('builtin-')) {
    payload.isBuiltIn = true;
    await presetRef.set(payload, { merge: true });
    emitUpdated(true);
    return { presetId, siteId: ctx.siteId, isBuiltInOverride: true };
  }

  const existing = await presetRef.get();
  if (!existing.exists) throw new TalonPresetNotFoundError(presetId);
  await presetRef.update(payload);
  emitUpdated(false);
  return { presetId, siteId: ctx.siteId, isBuiltInOverride: false };
}
