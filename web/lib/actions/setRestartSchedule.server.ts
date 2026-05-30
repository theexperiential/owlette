/**
 * Action core: set the restart schedule on a machine's config doc.
 *
 * Mirrors the client write at `useFirestore.updateRestartSchedule`. The
 * agent's existing config listener picks the new schedule up and propagates
 * it to local `config.json`, where the reboot state machine reads it. This
 * means the schedule survives Firestore disconnections — the agent fires
 * from local cache.
 *
 * Storage note: the `rebootSchedule` config field, the `set_reboot_schedule`
 * audit verb, and the `reboot-schedule` endpoint id are wire/storage contracts
 * shared with deployed agents — they intentionally keep the legacy `reboot`
 * spelling. Only UI and code identifiers were renamed to "restart".
 *
 * No `configChangeFlag` is needed because the rule for the config doc
 * allows any user with site access to write directly. (Contrast: writes to
 * the machine status doc require configChangeFlag.)
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface RestartScheduleEntryInput {
  id: string;
  days: string[];
  time: string;
}

export interface RestartScheduleInput {
  enabled: boolean;
  entries: RestartScheduleEntryInput[];
}

export interface SetRestartScheduleInput {
  machineId: string;
  schedule: RestartScheduleInput;
}

export interface SetRestartScheduleResult {
  machineId: string;
}

const TIME_RE = /^\d{2}:\d{2}$/;

function validateSchedule(s: unknown): asserts s is RestartScheduleInput {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new ActionInputError(400, 'invalid_schedule', 'Field `schedule` must be an object.');
  }
  const obj = s as Record<string, unknown>;
  if (typeof obj.enabled !== 'boolean') {
    throw new ActionInputError(
      400,
      'invalid_schedule_enabled',
      'Field `schedule.enabled` must be a boolean.',
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new ActionInputError(
      400,
      'invalid_schedule_entries',
      'Field `schedule.entries` must be an array.',
    );
  }
  for (const e of obj.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new ActionInputError(
        400,
        'invalid_schedule_entry',
        'Each schedule entry must be an object.',
      );
    }
    const entry = e as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new ActionInputError(
        400,
        'invalid_schedule_entry',
        'Schedule entry `id` is required.',
      );
    }
    if (!Array.isArray(entry.days) || entry.days.length === 0) {
      throw new ActionInputError(
        400,
        'invalid_schedule_entry',
        'Schedule entry `days` must be a non-empty array.',
      );
    }
    if (typeof entry.time !== 'string' || !TIME_RE.test(entry.time)) {
      throw new ActionInputError(
        400,
        'invalid_schedule_entry',
        'Schedule entry `time` must be in HH:MM 24h format.',
      );
    }
  }
}

export async function setRestartSchedule(
  ctx: ActionContext,
  input: SetRestartScheduleInput,
): Promise<SetRestartScheduleResult> {
  validateSchedule(input.schedule);

  const db = getAdminDb();
  const configRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('machines')
    .doc(input.machineId);

  // `rebootSchedule` field name is a wire contract read by deployed agents — keep it.
  await configRef.set({ rebootSchedule: input.schedule }, { merge: true });

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: input.machineId,
    attributes: {
      verb: 'set_reboot_schedule',
      endpoint: 'reboot-schedule',
      method: 'PUT',
      machineId: input.machineId,
      enabled: input.schedule.enabled,
      entryCount: input.schedule.entries.length,
    },
  });

  logger.info(
    `Restart schedule set on ${input.machineId} (enabled=${input.schedule.enabled}, entries=${input.schedule.entries.length})`,
    { context: 'actions/setRestartSchedule' },
  );

  return { machineId: input.machineId };
}
