/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockWithProcessLock = jest.fn();
const mockGenerateProcessId = jest.fn(() => 'gen-uuid-1');
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
    generateProcessId: () => mockGenerateProcessId(),
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

import {
  createProcess,
  ActionInputError,
  type CreateProcessInput,
  type ActionContext,
} from '@/lib/actions/createProcess.server';
import { ProcessConfigError } from '@/lib/processConfig.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const ACTOR: Actor = {
  type: 'user',
  userId: 'uid_alice',
  role: 'admin',
  sites: [SITE],
};
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid_alice' };

beforeEach(() => {
  jest.clearAllMocks();
  mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
    fn([]);
    return undefined;
  });
});

function input(overrides: Partial<CreateProcessInput> = {}): CreateProcessInput {
  return {
    machineId: MACHINE,
    name: 'TestProc',
    exe_path: 'C:/test.exe',
    ...overrides,
  };
}

describe('createProcess', () => {
  it('creates a new process and returns the generated processId', async () => {
    const result = await createProcess(CTX, input());
    expect(result.processId).toBe('gen-uuid-1');
    expect(mockWithProcessLock).toHaveBeenCalledTimes(1);
    expect(mockWithProcessLock).toHaveBeenCalledWith(SITE, MACHINE, expect.any(Function));
  });

  it('writes the new process row inside the transaction', async () => {
    let capturedProcesses: unknown[] = [];
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([]);
      capturedProcesses = out.processes;
      return out.result;
    });
    await createProcess(CTX, input({ name: 'New', exe_path: 'C:/x.exe' }));
    expect(capturedProcesses).toHaveLength(1);
    expect((capturedProcesses[0] as Record<string, unknown>).processId).toBe('gen-uuid-1');
    expect((capturedProcesses[0] as Record<string, unknown>).id).toBe('gen-uuid-1');
    expect((capturedProcesses[0] as Record<string, unknown>).name).toBe('New');
    expect((capturedProcesses[0] as Record<string, unknown>).launch_mode).toBe('off');
    expect((capturedProcesses[0] as Record<string, unknown>).autolaunch).toBe(false);
  });

  it('mirrors launch_mode -> autolaunch (always = autolaunch true)', async () => {
    let captured: Record<string, unknown> | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([]);
      captured = out.processes[0] as Record<string, unknown>;
      return out.result;
    });
    await createProcess(CTX, input({ launch_mode: 'always' }));
    expect(captured!.autolaunch).toBe(true);
    expect(captured!.launch_mode).toBe('always');
  });

  it('emits a process_mutated audit on success', async () => {
    await createProcess(CTX, input());
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        siteId: SITE,
        actor: 'user:uid_alice',
        targetId: 'gen-uuid-1',
        attributes: expect.objectContaining({
          verb: 'create',
          method: 'POST',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('throws ActionInputError when name is missing', async () => {
    await expect(createProcess(CTX, input({ name: '' }))).rejects.toThrow(ActionInputError);
  });

  it('throws ActionInputError when exe_path is missing', async () => {
    await expect(createProcess(CTX, input({ exe_path: '' }))).rejects.toThrow(ActionInputError);
  });

  it('does not emit audit when validation fails', async () => {
    await expect(createProcess(CTX, input({ name: '' }))).rejects.toThrow();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('propagates ProcessConfigError (e.g. duplicate-name from txn)', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new ProcessConfigError(409, 'Duplicate process name: X', 'duplicate_process_name'),
    );
    await expect(createProcess(CTX, input())).rejects.toThrow(ProcessConfigError);
  });

  it('uses apiKey audit actor when auditActor is "apiKey:..."', async () => {
    const apiCtx: ActionContext = {
      siteId: SITE,
      actor: ACTOR,
      auditActor: 'apiKey:key_abc',
    };
    await createProcess(apiCtx, input());
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'apiKey:key_abc' }),
    );
  });
});
