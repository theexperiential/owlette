/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

interface MockProcRow {
  processId: string;
  id: string;
  name: string;
  launch_mode?: string;
  autolaunch?: boolean;
  [k: string]: unknown;
}

const mockWithProcessLock = jest.fn();
const mockFindProcessIndex = jest.fn((procs: MockProcRow[], id: string) =>
  procs.findIndex((p) => p.processId === id),
);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/processConfig.server', () => {
  class FakeProcessConfigError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    withProcessLock: (...args: unknown[]) => mockWithProcessLock(...args),
    findProcessIndex: (procs: MockProcRow[], id: string) => mockFindProcessIndex(procs, id),
    ProcessConfigError: FakeProcessConfigError,
  };
});
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { updateProcess, type UpdateProcessInput } from '@/lib/actions/updateProcess.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';
import { ProcessConfigError } from '@/lib/processConfig.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const PID = 'proc-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', sites: [SITE] };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

function row(overrides: Partial<MockProcRow> = {}): MockProcRow {
  return {
    id: PID,
    processId: PID,
    name: 'TestProc',
    launch_mode: 'off',
    autolaunch: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

function patchInput(patch: Record<string, unknown>): UpdateProcessInput {
  return { machineId: MACHINE, processId: PID, patch };
}

describe('updateProcess', () => {
  it('updates fields atomically and returns the processId', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes[0] as MockProcRow;
      return out.result;
    });
    const result = await updateProcess(CTX, patchInput({ name: 'Updated' }));
    expect(result.processId).toBe(PID);
    expect(captured!.name).toBe('Updated');
    expect(captured!.processId).toBe(PID); // Re-pinned
    expect(captured!.id).toBe(PID);
  });

  it('mirrors launch_mode -> autolaunch on update', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes[0] as MockProcRow;
      return out.result;
    });
    await updateProcess(CTX, patchInput({ launch_mode: 'always' }));
    expect(captured!.launch_mode).toBe('always');
    expect(captured!.autolaunch).toBe(true);
  });

  it('rejects scheduled launch mode when no schedules exist', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => fn([row()]));
    await expect(
      updateProcess(CTX, patchInput({ launch_mode: 'scheduled' })),
    ).rejects.toMatchObject({ code: 'missing_schedules' });
  });

  it('allows scheduled launch mode when schedules are provided', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes[0] as MockProcRow;
      return out.result;
    });
    await updateProcess(
      CTX,
      patchInput({
        launch_mode: 'scheduled',
        schedules: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }],
      }),
    );
    expect(captured!.launch_mode).toBe('scheduled');
    expect(captured!.autolaunch).toBe(true);
  });

  it('throws ActionInputError on empty patch', async () => {
    await expect(updateProcess(CTX, patchInput({}))).rejects.toThrow(ActionInputError);
  });

  it('throws ActionInputError when patch tries to set processId', async () => {
    await expect(
      updateProcess(CTX, patchInput({ processId: 'evil' })),
    ).rejects.toThrow(ActionInputError);
  });

  it('throws ActionInputError when patch tries to set id', async () => {
    await expect(updateProcess(CTX, patchInput({ id: 'evil' }))).rejects.toThrow(
      ActionInputError,
    );
  });

  it('propagates 404 ProcessConfigError when process not found', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => fn([]));
    await expect(updateProcess(CTX, patchInput({ name: 'X' }))).rejects.toThrow(
      ProcessConfigError,
    );
  });

  it('emits process_mutated audit with verb=update', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([row()]);
      return undefined;
    });
    await updateProcess(CTX, patchInput({ name: 'Y' }));
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({ verb: 'update', method: 'PATCH' }),
      }),
    );
  });

  it('does not emit audit when validation fails', async () => {
    await expect(updateProcess(CTX, patchInput({}))).rejects.toThrow();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
