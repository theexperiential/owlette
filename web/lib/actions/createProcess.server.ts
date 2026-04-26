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
  if (!input.name || typeof input.name !== 'string') {
    throw new ActionInputError(400, 'missing_field', 'Field `name` is required.');
  }
  if (!input.exe_path || typeof input.exe_path !== 'string') {
    throw new ActionInputError(400, 'missing_field', 'Field `exe_path` is required.');
  }

  const newProcessId = generateProcessId();
  const launchMode = input.launch_mode ?? 'off';

  await withProcessLock(ctx.siteId, input.machineId, (processes) => {
    const newProcess: PublicProcessConfig = {
      id: newProcessId,
      processId: newProcessId,
      name: input.name,
      exe_path: input.exe_path,
      file_path: input.file_path ?? '',
      cwd: input.cwd ?? '',
      priority: input.priority ?? 'Normal',
      visibility: input.visibility ?? 'Show',
      time_delay: input.time_delay ?? '0',
      time_to_init: input.time_to_init ?? '10',
      relaunch_attempts: input.relaunch_attempts ?? '3',
      autolaunch: launchMode !== 'off',
      launch_mode: launchMode,
      schedules: input.schedules ?? null,
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
      machineId: input.machineId,
    },
  });

  logger.info(`Process created: ${input.name} on ${input.machineId}`, {
    context: 'actions/createProcess',
  });

  return { processId: newProcessId };
}

export { ProcessConfigError };
