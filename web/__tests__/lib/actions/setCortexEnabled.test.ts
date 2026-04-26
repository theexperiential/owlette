/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ update: mockUpdate }),
        }),
      }),
    }),
  }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { setCortexEnabled } from '@/lib/actions/setCortexEnabled.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', sites: [SITE] };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setCortexEnabled', () => {
  it('writes cortexEnabled=true to the machine status doc', async () => {
    const result = await setCortexEnabled(CTX, { machineId: MACHINE, enabled: true });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ cortexEnabled: true });
    expect(result).toEqual({ machineId: MACHINE, enabled: true });
  });

  it('writes cortexEnabled=false to disable', async () => {
    await setCortexEnabled(CTX, { machineId: MACHINE, enabled: false });
    expect(mockUpdate).toHaveBeenCalledWith({ cortexEnabled: false });
  });

  it('rejects non-boolean enabled', async () => {
    await expect(
      // @ts-expect-error — testing runtime validation
      setCortexEnabled(CTX, { machineId: MACHINE, enabled: 'true' }),
    ).rejects.toThrow(ActionInputError);
  });

  it('emits an audit with verb=set_cortex_enabled', async () => {
    await setCortexEnabled(CTX, { machineId: MACHINE, enabled: true });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: MACHINE,
        attributes: expect.objectContaining({
          verb: 'set_cortex_enabled',
          method: 'PATCH',
          enabled: true,
        }),
      }),
    );
  });

  it('does not write or audit when validation fails', async () => {
    await expect(
      // @ts-expect-error — testing runtime validation
      setCortexEnabled(CTX, { machineId: MACHINE, enabled: 1 }),
    ).rejects.toThrow();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
