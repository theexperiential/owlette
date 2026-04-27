/**
 * createSchedulePreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useSchedulePresets:createPreset` (web/hooks/useSchedulePresets.ts:134-148):
 * generates a preset id, writes the doc to `config/{siteId}/schedule_presets/{presetId}`,
 * and stamps `createdAt = serverTimestamp()`.
 *
 * Pure action — does not touch HTTP. The route shim wraps this with
 * `authorizedSiteHandler({ capability: 'PRESET_MANAGE', siteIdParam: 'path' })`.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

/** Time range within a day. Mirrors web/hooks/useFirestore.ts:TimeRange. */
export interface TimeRange {
  start: string; // "HH:MM"
  stop: string;  // "HH:MM"
}

/** A single block within a schedule preset. Mirrors web/hooks/useFirestore.ts:ScheduleBlock. */
export interface ScheduleBlockInput {
  name?: string;
  colorIndex?: number;
  days: string[];
  ranges: TimeRange[];
}

export interface CreateSchedulePresetInput {
  name: string;
  description?: string;
  blocks: ScheduleBlockInput[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
}

export interface CreateSchedulePresetResult {
  presetId: string;
  siteId: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export class SchedulePresetValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'SchedulePresetValidationError';
  }
}

export function validateSchedulePresetInput(
  input: Partial<CreateSchedulePresetInput>,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): void {
  if (!allowPartial || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new SchedulePresetValidationError('name', 'name is required and must be a non-empty string');
    }
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new SchedulePresetValidationError('description', 'description must be a string when provided');
  }
  if (!allowPartial || input.blocks !== undefined) {
    if (!Array.isArray(input.blocks)) {
      throw new SchedulePresetValidationError('blocks', 'blocks must be an array');
    }
    for (let i = 0; i < input.blocks.length; i++) {
      const block = input.blocks[i] as ScheduleBlockInput | undefined;
      if (!block || typeof block !== 'object') {
        throw new SchedulePresetValidationError(`blocks[${i}]`, 'block must be an object');
      }
      if (!Array.isArray(block.days) || block.days.some((d) => typeof d !== 'string' || !VALID_DAYS.has(d))) {
        throw new SchedulePresetValidationError(
          `blocks[${i}].days`,
          'days must be a non-empty array of mon/tue/wed/thu/fri/sat/sun',
        );
      }
      if (!Array.isArray(block.ranges)) {
        throw new SchedulePresetValidationError(`blocks[${i}].ranges`, 'ranges must be an array');
      }
      for (let r = 0; r < block.ranges.length; r++) {
        const range = block.ranges[r];
        if (!range || typeof range !== 'object') {
          throw new SchedulePresetValidationError(`blocks[${i}].ranges[${r}]`, 'range must be an object');
        }
        if (typeof range.start !== 'string' || !HHMM_RE.test(range.start)) {
          throw new SchedulePresetValidationError(`blocks[${i}].ranges[${r}].start`, 'start must be HH:MM 24h');
        }
        if (typeof range.stop !== 'string' || !HHMM_RE.test(range.stop)) {
          throw new SchedulePresetValidationError(`blocks[${i}].ranges[${r}].stop`, 'stop must be HH:MM 24h');
        }
      }
      if (block.name !== undefined && typeof block.name !== 'string') {
        throw new SchedulePresetValidationError(`blocks[${i}].name`, 'name must be a string when provided');
      }
      if (block.colorIndex !== undefined && (typeof block.colorIndex !== 'number' || !Number.isFinite(block.colorIndex))) {
        throw new SchedulePresetValidationError(`blocks[${i}].colorIndex`, 'colorIndex must be a finite number');
      }
    }
  }
  if (!allowPartial || input.isBuiltIn !== undefined) {
    if (typeof input.isBuiltIn !== 'boolean') {
      throw new SchedulePresetValidationError('isBuiltIn', 'isBuiltIn is required and must be a boolean');
    }
  }
  if (!allowPartial || input.order !== undefined) {
    if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
      throw new SchedulePresetValidationError('order', 'order is required and must be a finite number');
    }
  }
  if (!allowPartial || input.createdBy !== undefined) {
    if (typeof input.createdBy !== 'string') {
      throw new SchedulePresetValidationError('createdBy', 'createdBy is required and must be a string');
    }
  }
}

/**
 * Generate a deterministic preset id matching the client-side convention
 * (`sched-{slug}-{epochMs}`). See useSchedulePresets.ts:139.
 */
function generatePresetId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `sched-${slug || 'preset'}-${Date.now()}`;
}

export async function createSchedulePreset(
  ctx: SiteHandlerContext,
  input: CreateSchedulePresetInput,
): Promise<CreateSchedulePresetResult> {
  validateSchedulePresetInput(input);

  const db = getAdminDb();
  const presetId = generatePresetId(input.name);
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('schedule_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    blocks: input.blocks,
    isBuiltIn: input.isBuiltIn,
    order: input.order,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.description !== undefined) payload.description = input.description;

  await presetRef.set(payload);

  return { presetId, siteId: ctx.siteId };
}
