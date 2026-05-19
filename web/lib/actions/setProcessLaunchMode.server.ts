/**
 * Action core: set a process's launch mode (and optional schedule).
 *
 * Performs two writes:
 *   1. Atomic config-doc update via `withProcessLock` — the source of truth.
 *   2. Best-effort mirror onto the machine status doc so the dashboard sees
 *      the new mode immediately without waiting for the next agent
 *      heartbeat. Failure here is non-critical (agent will reconcile).
 */
import { getAdminDb } from '@/lib/firebase-admin';
import {
  withProcessLock,
  findProcessIndex,
  ProcessConfigError,
  type ScheduleBlock,
  type PublicProcessConfig,
} from '@/lib/processConfig.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export const VALID_LAUNCH_MODES = ['off', 'always', 'scheduled'] as const;
export type LaunchMode = (typeof VALID_LAUNCH_MODES)[number];

export interface SetProcessLaunchModeInput {
  machineId: string;
  processId: string;
  mode: LaunchMode;
  /** Required when `mode === 'scheduled'`. */
  schedules?: ScheduleBlock[];
  /** Optional preset id to mirror onto the row. Pass `null` to clear. */
  schedulePresetId?: string | null;
}

export interface SetProcessLaunchModeResult {
  processId: string;
  mode: LaunchMode;
}

function cleanScheduleBlocks(blocks: ScheduleBlock[]): Record<string, unknown>[] {
  return blocks.map((b) => {
    const clean: Record<string, unknown> = { days: b.days, ranges: b.ranges };
    if (b.name) clean.name = b.name;
    if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
    return clean;
  });
}

export async function setProcessLaunchMode(
  ctx: ActionContext,
  input: SetProcessLaunchModeInput,
): Promise<SetProcessLaunchModeResult> {
  const { machineId, processId, mode, schedules, schedulePresetId } = input;

  if (!VALID_LAUNCH_MODES.includes(mode)) {
    throw new ActionInputError(
      400,
      'invalid_mode',
      `Invalid mode. Must be one of: ${VALID_LAUNCH_MODES.join(', ')}`,
    );
  }
  if (mode === 'scheduled' && (!Array.isArray(schedules) || schedules.length === 0)) {
    throw new ActionInputError(
      400,
      'missing_schedules',
      'Schedules array is required when mode is "scheduled".',
    );
  }

  // 1. Update config (source of truth).
  await withProcessLock(ctx.siteId, machineId, (processes) => {
    const idx = findProcessIndex(processes, processId);
    if (idx === -1) {
      throw new ProcessConfigError(404, `Process ${processId} not found`, 'process_not_found');
    }
    const updated = [...processes];
    const merged: PublicProcessConfig = {
      ...updated[idx],
      launch_mode: mode,
      autolaunch: mode !== 'off',
      ...(schedules !== undefined ? { schedules } : {}),
      ...(schedulePresetId !== undefined
        ? { schedulePresetId: schedulePresetId || null }
        : {}),
    };
    updated[idx] = merged;
    return { processes: updated, result: undefined };
  });

  // 2. Mirror to status doc (non-critical).
  try {
    const db = getAdminDb();
    const statusRef = db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machineId);

    const statusUpdate: Record<string, unknown> = {
      [`metrics.processes.${processId}.launch_mode`]: mode,
      [`metrics.processes.${processId}.autolaunch`]: mode !== 'off',
    };
    if (schedules !== undefined) {
      statusUpdate[`metrics.processes.${processId}.schedules`] =
        cleanScheduleBlocks(schedules);
    }
    if (schedulePresetId !== undefined) {
      statusUpdate[`metrics.processes.${processId}.schedulePresetId`] =
        schedulePresetId || null;
    }
    await statusRef.update(statusUpdate);
  } catch {
    // Non-critical — agent reconciles config on its own poll cycle.
  }

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: processId,
    attributes: {
      verb: 'set_launch_mode',
      endpoint: 'processes/launch-mode',
      method: 'PATCH',
      machineId,
      mode,
    },
  });

  logger.info(`Launch mode set to ${mode} for process ${processId} on ${machineId}`, {
    context: 'actions/setProcessLaunchMode',
  });

  return { processId, mode };
}
