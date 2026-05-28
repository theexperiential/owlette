/**
 * createRebootPreset action core (security-boundary-migration wave 3.6).
 *
 * Mirrors `useRebootPresets:createPreset` (web/hooks/useRebootPresets.ts:128-142):
 * generates a preset id, writes the doc to `config/{siteId}/reboot_presets/{presetId}`,
 * and stamps `createdAt = serverTimestamp()`.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

/** Mirrors web/hooks/useFirestore.ts:RebootScheduleEntry. */
export interface RebootScheduleEntryInput {
  id: string;       // crypto.randomUUID() at creation
  days: string[];   // e.g. ['mon','tue','wed','thu','fri']
  time: string;     // "HH:MM" 24h
}

export interface CreateRebootPresetInput {
  name: string;
  description?: string;
  /** Whether the schedule is active when this preset is applied. */
  enabled?: boolean;
  entries: RebootScheduleEntryInput[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
}

export interface CreateRebootPresetResult {
  presetId: string;
  siteId: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class RebootPresetValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'RebootPresetValidationError';
  }
}

export function validateRebootPresetInput(
  input: Partial<CreateRebootPresetInput>,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): void {
  if (!allowPartial || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new RebootPresetValidationError('name', 'name is required and must be a non-empty string');
    }
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new RebootPresetValidationError('description', 'description must be a string when provided');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new RebootPresetValidationError('enabled', 'enabled must be a boolean when provided');
  }
  if (!allowPartial || input.entries !== undefined) {
    if (!Array.isArray(input.entries)) {
      throw new RebootPresetValidationError('entries', 'entries must be an array');
    }
    for (let i = 0; i < input.entries.length; i++) {
      const entry = input.entries[i] as RebootScheduleEntryInput | undefined;
      if (!entry || typeof entry !== 'object') {
        throw new RebootPresetValidationError(`entries[${i}]`, 'entry must be an object');
      }
      if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
        throw new RebootPresetValidationError(`entries[${i}].id`, 'entry id must be a non-empty string');
      }
      if (!Array.isArray(entry.days) || entry.days.some((d) => typeof d !== 'string' || !VALID_DAYS.has(d))) {
        throw new RebootPresetValidationError(
          `entries[${i}].days`,
          'days must be a non-empty array of mon/tue/wed/thu/fri/sat/sun',
        );
      }
      if (typeof entry.time !== 'string' || !HHMM_RE.test(entry.time)) {
        throw new RebootPresetValidationError(`entries[${i}].time`, 'time must be HH:MM 24h');
      }
    }
  }
  if (!allowPartial || input.isBuiltIn !== undefined) {
    if (typeof input.isBuiltIn !== 'boolean') {
      throw new RebootPresetValidationError('isBuiltIn', 'isBuiltIn is required and must be a boolean');
    }
  }
  if (!allowPartial || input.order !== undefined) {
    if (typeof input.order !== 'number' || !Number.isFinite(input.order)) {
      throw new RebootPresetValidationError('order', 'order is required and must be a finite number');
    }
  }
  if (!allowPartial || input.createdBy !== undefined) {
    if (typeof input.createdBy !== 'string') {
      throw new RebootPresetValidationError('createdBy', 'createdBy is required and must be a string');
    }
  }
}

/**
 * Mirrors useRebootPresets.ts:133 — `reboot-{slug}-{epochMs}`.
 */
function generatePresetId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `reboot-${slug || 'preset'}-${Date.now()}`;
}

export async function createRebootPreset(
  ctx: SiteHandlerContext,
  input: CreateRebootPresetInput,
): Promise<CreateRebootPresetResult> {
  validateRebootPresetInput(input);

  const db = getAdminDb();
  const presetId = generatePresetId(input.name);
  const presetRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('reboot_presets')
    .doc(presetId);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    entries: input.entries,
    isBuiltIn: input.isBuiltIn,
    order: input.order,
    createdBy: ctx.actor.userId,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.description !== undefined) payload.description = input.description;
  if (input.enabled !== undefined) payload.enabled = input.enabled;

  await presetRef.set(payload);

  return { presetId, siteId: ctx.siteId };
}
