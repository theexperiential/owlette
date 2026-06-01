/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: mockSet }),
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

import { setRestartSchedule } from '@/lib/actions/setRestartSchedule.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', sites: [SITE] };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setRestartSchedule', () => {
  it('writes the schedule with merge:true', async () => {
    await setRestartSchedule(CTX, {
      machineId: MACHINE,
      schedule: {
        enabled: true,
        entries: [{ id: 'a', days: ['mon'], time: '03:00' }],
      },
    });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockSet.mock.calls[0];
    expect(payload).toEqual({
      rebootSchedule: {
        enabled: true,
        entries: [{ id: 'a', days: ['mon'], time: '03:00' }],
      },
    });
    expect(opts).toEqual({ merge: true });
  });

  it('rejects non-boolean enabled', async () => {
    await expect(
      setRestartSchedule(CTX, {
        machineId: MACHINE,
        // @ts-expect-error — testing runtime validation
        schedule: { enabled: 'yes', entries: [] },
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects non-array entries', async () => {
    await expect(
      setRestartSchedule(CTX, {
        machineId: MACHINE,
        // @ts-expect-error — testing runtime validation
        schedule: { enabled: true, entries: 'nope' },
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects entry missing id', async () => {
    await expect(
      setRestartSchedule(CTX, {
        machineId: MACHINE,
        schedule: {
          enabled: true,
          // @ts-expect-error — testing runtime validation
          entries: [{ days: ['mon'], time: '03:00' }],
        },
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects entry with invalid time format', async () => {
    await expect(
      setRestartSchedule(CTX, {
        machineId: MACHINE,
        schedule: {
          enabled: true,
          entries: [{ id: 'a', days: ['mon'], time: '3am' }],
        },
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects entry with empty days array', async () => {
    await expect(
      setRestartSchedule(CTX, {
        machineId: MACHINE,
        schedule: {
          enabled: true,
          entries: [{ id: 'a', days: [], time: '03:00' }],
        },
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('emits an audit with the entry count', async () => {
    await setRestartSchedule(CTX, {
      machineId: MACHINE,
      schedule: {
        enabled: false,
        entries: [
          { id: 'a', days: ['mon'], time: '03:00' },
          { id: 'b', days: ['fri'], time: '04:00' },
        ],
      },
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          verb: 'set_reboot_schedule',
          enabled: false,
          entryCount: 2,
        }),
      }),
    );
  });

  it('accepts disabled schedule with empty entries', async () => {
    await setRestartSchedule(CTX, {
      machineId: MACHINE,
      schedule: { enabled: false, entries: [] },
    });
    expect(mockSet).toHaveBeenCalledTimes(1);
  });
});
