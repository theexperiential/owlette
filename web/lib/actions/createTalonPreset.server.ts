/**
 * Reusable talon templates, following the other preset families under `config/`
 * exactly: writes `config/{siteId}/talon_presets/{presetId}`, stamps `createdAt`
 * and a trusted `createdBy`, and ships `isBuiltIn`/`order` for the client's
 * built-in merge.
 *
 * The talon payload is not re-validated here — `validateTalonPresetInput`
 * delegates to `validateTalonInput`, so a preset can never hold a talon the store
 * would refuse. Capability is `PRESET_MANAGE`, not `TALON_MANAGE`: curating a
 * template touches no machine.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import type { TalonPresetTemplate } from '@/lib/talons/types';
import {
  TALON_DESCRIPTION_MAX_LENGTH,
  TALON_NAME_MAX_LENGTH,
  validateTalonPresetInput,
  type TalonFieldError,
} from '@/lib/talons/validation';
import { siteAuditActor } from './auditActor.server';

export interface CreateTalonPresetInput {
  name: string;
  description?: string;
  /** Raw — `validateTalonPresetInput` owns the shape. */
  template: unknown;
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
}

export interface CreateTalonPresetResult {
  presetId: string;
  siteId: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class TalonPresetValidationError extends Error {
  field: string;
  /** Present when the failure came from the delegated talon validator. */
  fieldErrors?: TalonFieldError[];

  constructor(field: string, message: string, fieldErrors?: TalonFieldError[]) {
    super(message);
    this.field = field;
    this.name = 'TalonPresetValidationError';
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

/**
 * Validate the preset's identity fields, and its template unless a PATCH omitted
 * it. Returns the normalized template so both paths persist the validator's
 * output, never the raw input.
 */
export function validateTalonPresetFields(
  input: Partial<CreateTalonPresetInput>,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): TalonPresetTemplate | undefined {
  if (!allowPartial || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new TalonPresetValidationError('name', 'name is required and must be a non-empty string');
    }
    if (input.name.trim().length > TALON_NAME_MAX_LENGTH) {
      throw new TalonPresetValidationError(
        'name',
        `name must be ${TALON_NAME_MAX_LENGTH} characters or fewer`,
      );
    }
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new TalonPresetValidationError('description', 'description must be a string when provided');
    }
    if (input.description.length > TALON_DESCRIPTION_MAX_LENGTH) {
      throw new TalonPresetValidationError(
        'description',
        `description must be ${TALON_DESCRIPTION_MAX_LENGTH} characters or fewer`,
      );
    }
  }
  if (!allowPartial || input.isBuiltIn !== undefined) {
    if (typeof input.isBuiltIn !== 'boolean') {
      throw new TalonPresetValidationError('isBuiltIn', 'isBuiltIn is required and must be a boolean');
    }
  }
  if (!allowPartial || input.order !== undefined) {
    if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
      throw new TalonPresetValidationError('order', 'order is required and must be a finite number');
    }
  }
  if (!allowPartial || input.createdBy !== undefined) {
    if (typeof input.createdBy !== 'string') {
      throw new TalonPresetValidationError('createdBy', 'createdBy is required and must be a string');
    }
  }

  if (allowPartial && input.template === undefined) return undefined;

  const result = validateTalonPresetInput(input.template);
  if (!result.ok) {
    const [first, ...rest] = result.errors;
    const summary = rest.length > 0 ? `${first.message} (+${rest.length} more)` : first.message;
    throw new TalonPresetValidationError(first.field, summary, result.errors);
  }
  return result.value;
}

/** Stored preset id format: `talon-{slug}-{epochMs}`, matching the other families. */
function generatePresetId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `talon-${slug || 'preset'}-${Date.now()}`;
}

export async function createTalonPreset(
  ctx: SiteHandlerContext,
  input: CreateTalonPresetInput,
): Promise<CreateTalonPresetResult> {
  const template = validateTalonPresetFields(input);

  const db = getAdminDb();
  const presetId = generatePresetId(input.name);
  if (!ID_RE.test(presetId)) {
    // Only reachable if the slug rules change: a doc id the read routes reject is
    // worse than a 400 here.
    throw new TalonPresetValidationError('name', 'name produced an unusable preset id');
  }
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('talon_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    template,
    isBuiltIn: input.isBuiltIn,
    order: input.order,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.description !== undefined) payload.description = input.description;

  await presetRef.set(payload);

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: siteAuditActor(ctx),
    targetId: presetId,
    attributes: {
      verb: 'preset.create',
      endpoint: 'presets/talon',
      method: 'POST',
      family: 'talon',
      presetId,
      isBuiltIn: input.isBuiltIn,
    },
  });

  return { presetId, siteId: ctx.siteId };
}
