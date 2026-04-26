/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

interface MockProcRow {
  processId: string;
  id: string;
  name: string;
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

import { deleteProcess } from '@/lib/actions/deleteProcess.server';
import type { ActionContext } from '@/lib/actions/createProcess.server';
import { ProcessConfigError } from '@/lib/processConfig.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const PID = 'proc-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', sites: [SITE] };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

function row(): MockProcRow {
  return { id: PID, processId: PID, name: 'TestProc' };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('deleteProcess', () => {
  it('removes the process row and returns alreadyDeleted=false', async () => {
    let captured: MockProcRow[] = [];
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes;
      return out.result;
    });
    const result = await deleteProcess(CTX, { machineId: MACHINE, processId: PID });
    expect(result).toEqual({ processId: PID, alreadyDeleted: false });
    expect(captured).toHaveLength(0);
  });

  it('returns alreadyDeleted=true when process is already missing', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([]);
      return undefined;
    });
    const result = await deleteProcess(CTX, { machineId: MACHINE, processId: PID });
    expect(result).toEqual({ processId: PID, alreadyDeleted: true });
  });

  it('treats missing config doc as alreadyDeleted=true (404 swallowed)', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new ProcessConfigError(404, 'Configuration not found for this machine'),
    );
    const result = await deleteProcess(CTX, { machineId: MACHINE, processId: PID });
    expect(result).toEqual({ processId: PID, alreadyDeleted: true });
  });

  it('propagates non-404 ProcessConfigError', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new ProcessConfigError(500, 'something else'),
    );
    await expect(
      deleteProcess(CTX, { machineId: MACHINE, processId: PID }),
    ).rejects.toThrow(ProcessConfigError);
  });

  it('emits a process_mutated audit on delete (even on no-op)', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([]);
      return undefined;
    });
    await deleteProcess(CTX, { machineId: MACHINE, processId: PID });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({
          verb: 'delete',
          method: 'DELETE',
          alreadyDeleted: true,
        }),
      }),
    );
  });
});
