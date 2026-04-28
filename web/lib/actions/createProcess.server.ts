/**
 * Action core: create a new process on a machine.
 *
 * Extracted from `web/app/api/sites/[siteId]/machines/[machineId]/processes/route.ts`
 * (POST) so it can be reused from the public route + future server-side
 * callers (cortex tool dispatch, scheduled jobs).
 *
 * Pure-ish logic: validates the input, runs the transactional
 * `withProcessLock` write, emits the audit event. Auth + capability +
 * rate-limit are the wrapper's job — this function assumes it's running
 * inside an `authorizedSiteHandler` (or `invokeAsSystem`) call frame.
 */
import {
  withProcessLock,
  generateProcessId,
  ProcessConfigError,
  type PublicProcessConfig,
} from '@/lib/processConfig.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import type { Actor } from '@/lib/capabilities';
import { validateCreateProcessFields } from '@/lib/processPayloadValidation';

export class ActionInputError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface CreateProcessInput {
  machineId: string;
  name: string;
  exe_path: string;
  file_path?: string;
  cwd?: string;
  priority?: string;
  visibility?: string;
  time_delay?: string;
  time_to_init?: string;
  relaunch_attempts?: string;
  launch_mode?: 'off' | 'always' | 'scheduled';
  schedules?: PublicProcessConfig['schedules'];
  schedulePresetId?: string | null;
}

export interface CreateProcessResult {
  processId: string;
}

export interface ActionContext {
  siteId: string;
  actor: Actor;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
}

export async function createProcess(
  ctx: ActionContext,
  input: CreateProcessInput,
): Promise<CreateProcessResult> {
  const { machineId, ...fields } = input;
  const validation = validateCreateProcessFields(fields as Record<string, unknown>);
  if (!validation.ok) {
    throw new ActionInputError(
      validation.error.status,
      validation.error.code,
      validation.error.detail,
    );
  }
  const processInput = validation.value;

  const newProcessId = generateProcessId();
  const launchMode = processInput.launch_mode ?? 'off';

  await withProcessLock(ctx.siteId, machineId, (processes) => {
    const newProcess: PublicProcessConfig = {
      id: newProcessId,
      processId: newProcessId,
      name: processInput.name,
      exe_path: processInput.exe_path,
      file_path: processInput.file_path ?? '',
      cwd: processInput.cwd ?? '',
      priority: processInput.priority ?? 'Normal',
      visibility: processInput.visibility ?? 'Show',
      time_delay: processInput.time_delay ?? '0',
      time_to_init: processInput.time_to_init ?? '10',
      relaunch_attempts: processInput.relaunch_attempts ?? '3',
      autolaunch: launchMode !== 'off',
      launch_mode: launchMode,
      schedules: processInput.schedules ?? null,
      ...(processInput.schedulePresetId !== undefined
        ? { schedulePresetId: processInput.schedulePresetId }
        : {}),
    };
    return {
      processes: [...processes, newProcess],
      result: newProcessId,
    };
  });

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: newProcessId,
    attributes: {
      verb: 'create',
      endpoint: 'processes',
      method: 'POST',
      machineId,
    },
  });

  logger.info(`Process created: ${processInput.name} on ${machineId}`, {
    context: 'actions/createProcess',
  });

  return { processId: newProcessId };
}

export { ProcessConfigError };
