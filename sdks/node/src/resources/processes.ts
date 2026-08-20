/**
 * `owlette.processes(siteId, machineId)` — scoped process management over
 * `/api/sites/{siteId}/machines/{machineId}/processes[/{processId}[/action]]`.
 *
 * Bound to a (siteId, machineId) tuple and exposed as a factory on the root
 * `Owlette` instance, matching the api's nesting without repeating both ids on
 * every call: `owlette.processes(siteId, machineId).list()`.
 */
import { randomUUID } from 'crypto';
import type { OwletteClient } from '../lib/client';

export type ProcessLaunchMode = 'off' | 'always' | 'scheduled';

export interface ProcessScheduleBlock {
  days: string[];
  ranges: Array<{ start: string; stop: string }>;
}

export interface ProcessSummary {
  processId: string;
  name: string;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  autolaunch: boolean;
  launch_mode: ProcessLaunchMode;
  schedules: ProcessScheduleBlock[] | null;
  schedule: { mode: ProcessLaunchMode; blocks?: ProcessScheduleBlock[] } | null;
  schedulePresetId: string | null;
  status: string;
  pid: number | null;
  responsive: boolean;
  last_updated: string | number | null;
}

export interface ListProcessesResult {
  processes: ProcessSummary[];
  nextPageToken: string | null;
}

export interface CreateProcessOptions {
  name: string;
  exe_path: string;
  file_path?: string;
  cwd?: string;
  priority?: string;
  visibility?: string;
  time_delay?: string;
  time_to_init?: string;
  relaunch_attempts?: string;
  launch_mode?: ProcessLaunchMode;
  schedules?: ProcessScheduleBlock[] | null;
  idempotencyKey?: string;
}

export type UpdateProcessOptions = Partial<
  Omit<CreateProcessOptions, 'idempotencyKey'>
> & {
  idempotencyKey?: string;
};

export interface ScheduleOptions {
  mode: ProcessLaunchMode;
  blocks?: ProcessScheduleBlock[];
  idempotencyKey?: string;
}

/**
 * `restart` response. The server queues an agent command and returns its id at
 * once; poll `owlette.machines.getCommand(siteId, machineId, commandId)`.
 */
export interface RestartProcessResult {
  commandId: string;
  status: string;
}

export class Processes {
  constructor(
    private readonly client: OwletteClient,
    private readonly siteId: string,
    private readonly machineId: string,
  ) {}

  private get base(): string {
    return `/api/sites/${encodeURIComponent(this.siteId)}/machines/${encodeURIComponent(this.machineId)}/processes`;
  }

  async list(): Promise<ListProcessesResult> {
    const res = await this.client.request<{
      ok: true;
      data: ListProcessesResult;
    }>(this.base);
    return res.data.data;
  }

  async get(processId: string): Promise<ProcessSummary> {
    const res = await this.client.request<{ ok: true; data: ProcessSummary }>(
      `${this.base}/${encodeURIComponent(processId)}`,
    );
    return res.data.data;
  }

  async create(opts: CreateProcessOptions): Promise<{ processId: string }> {
    const body: Record<string, unknown> = {
      name: opts.name,
      exe_path: opts.exe_path,
    };
    if (opts.file_path !== undefined) body.file_path = opts.file_path;
    if (opts.cwd !== undefined) body.cwd = opts.cwd;
    if (opts.priority !== undefined) body.priority = opts.priority;
    if (opts.visibility !== undefined) body.visibility = opts.visibility;
    if (opts.time_delay !== undefined) body.time_delay = opts.time_delay;
    if (opts.time_to_init !== undefined) body.time_to_init = opts.time_to_init;
    if (opts.relaunch_attempts !== undefined)
      body.relaunch_attempts = opts.relaunch_attempts;
    if (opts.launch_mode !== undefined) body.launch_mode = opts.launch_mode;
    if (opts.schedules !== undefined) body.schedules = opts.schedules;

    const res = await this.client.request<{
      ok: true;
      data: { processId: string };
    }>(this.base, {
      method: 'POST',
      body,
      idempotencyKey:
        opts.idempotencyKey ?? `sdk-processes-create-${randomUUID()}`,
    });
    return res.data.data;
  }

  async update(
    processId: string,
    opts: UpdateProcessOptions,
  ): Promise<{ processId: string }> {
    const { idempotencyKey, ...patch } = opts;
    const res = await this.client.request<{
      ok: true;
      data: { processId: string };
    }>(`${this.base}/${encodeURIComponent(processId)}`, {
      method: 'PATCH',
      body: patch,
      idempotencyKey: idempotencyKey ?? `sdk-processes-update-${randomUUID()}`,
    });
    return res.data.data;
  }

  async delete(
    processId: string,
  ): Promise<{ processId: string; alreadyDeleted: boolean }> {
    const res = await this.client.request<{
      ok: true;
      data: { processId: string; alreadyDeleted: boolean };
    }>(`${this.base}/${encodeURIComponent(processId)}`, {
      method: 'DELETE',
    });
    return res.data.data;
  }

  async kill(
    processId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ ok: true; data: Record<string, unknown> }> {
    return this.controlVerb('kill', processId, opts.idempotencyKey);
  }

  async start(
    processId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ ok: true; data: Record<string, unknown> }> {
    return this.controlVerb('start', processId, opts.idempotencyKey);
  }

  async stop(
    processId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ ok: true; data: Record<string, unknown> }> {
    return this.controlVerb('stop', processId, opts.idempotencyKey);
  }

  /**
   * Queue a restart. Like `start`/`stop`/`kill`, but returns the command id and
   * status unwrapped. The server stops the process if running then starts it; the
   * agent reports each transition over the command stream.
   */
  async restart(
    processId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<RestartProcessResult> {
    const res = await this.client.request<{
      ok: true;
      data: RestartProcessResult;
    }>(`${this.base}/${encodeURIComponent(processId)}/restart`, {
      method: 'POST',
      body: {},
      idempotencyKey:
        opts.idempotencyKey ?? `sdk-processes-restart-${randomUUID()}`,
    });
    return res.data.data;
  }

  async schedule(
    processId: string,
    opts: ScheduleOptions,
  ): Promise<{ processId: string; mode: ProcessLaunchMode }> {
    const body: Record<string, unknown> = { mode: opts.mode };
    if (opts.blocks !== undefined) body.blocks = opts.blocks;

    const res = await this.client.request<{
      ok: true;
      data: { processId: string; mode: ProcessLaunchMode };
    }>(`${this.base}/${encodeURIComponent(processId)}/schedule`, {
      method: 'POST',
      body,
      idempotencyKey:
        opts.idempotencyKey ?? `sdk-processes-schedule-${randomUUID()}`,
    });
    return res.data.data;
  }

  private async controlVerb(
    verb: 'kill' | 'start' | 'stop',
    processId: string,
    idempotencyKey: string | undefined,
  ): Promise<{ ok: true; data: Record<string, unknown> }> {
    const res = await this.client.request<{
      ok: true;
      data: Record<string, unknown>;
    }>(`${this.base}/${encodeURIComponent(processId)}/${verb}`, {
      method: 'POST',
      body: {},
      idempotencyKey: idempotencyKey ?? `sdk-processes-${verb}-${randomUUID()}`,
    });
    return res.data;
  }
}
