/** @jest-environment node */

/**
 * Tests for the reboot preset action cores
 * (web/lib/actions/{create,update,delete}RebootPreset.server.ts).
 *
 * security-boundary-migration wave 3.6.
 */

interface MockDoc {
  exists: boolean;
  data: () => Record<string, unknown>;
}

const setCalls: Array<{ path: string; payload: Record<string, unknown>; merge?: boolean }> = [];
const updateCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
const deleteCalls: Array<{ path: string }> = [];
const docState: Map<string, MockDoc> = new Map();

function makeDoc(path: string) {
  return {
    get: async () => docState.get(path) ?? { exists: false, data: () => ({}) },
    set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
      setCalls.push({ path, payload, merge: opts?.merge });
      docState.set(path, { exists: true, data: () => payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
    },
    delete: async () => {
      deleteCalls.push({ path });
      docState.delete(path);
    },
  };
}

function makeCollection(path: string) {
  return { doc: (id: string) => makeDoc(`${path}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => ({
      doc: (siteId: string) => ({
        collection: (sub: string) => makeCollection(`${top}/${siteId}/${sub}`),
      }),
    }),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

import {
  createRebootPreset,
  RebootPresetValidationError,
} from '@/lib/actions/createRebootPreset.server';
import {
  updateRebootPreset,
  RebootPresetNotFoundError,
} from '@/lib/actions/updateRebootPreset.server';
import { deleteRebootPreset } from '@/lib/actions/deleteRebootPreset.server';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

const ctx: SiteHandlerContext = {
  actor: { type: 'user', userId: 'uid_alice', role: 'admin', sites: ['site-a'] },
  siteId: 'site-a',
  correlationId: 'cid_1',
  auth: { userId: 'uid_alice', keyContext: null },
  scopeCheck: { isLegacy: false },
};

beforeEach(() => {
  setCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  docState.clear();
});

describe('createRebootPreset', () => {
  it('creates a custom preset under config/{siteId}/reboot_presets', async () => {
    const result = await createRebootPreset(ctx, {
      name: 'Weekday 3am',
      entries: [{ id: 'entry-1', days: ['mon', 'tue'], time: '03:00' }],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });
    expect(result.siteId).toBe('site-a');
    expect(result.presetId).toMatch(/^reboot-weekday-3am-\d+$/);

    expect(setCalls).toHaveLength(1);
    const call = setCalls[0];
    expect(call.path.startsWith('config/site-a/reboot_presets/reboot-weekday-3am-')).toBe(true);
    expect(call.merge).toBeUndefined();
    expect(call.payload.name).toBe('Weekday 3am');
    expect(call.payload.isBuiltIn).toBe(false);
    expect(call.payload.createdAt).toBe('__SERVER_TS__');
  });

  it('rejects bad time string', async () => {
    await expect(
      createRebootPreset(ctx, {
        name: 'Bad',
        entries: [{ id: 'e', days: ['mon'], time: '25:99' }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(RebootPresetValidationError);
  });

  it('rejects invalid day code', async () => {
    await expect(
      createRebootPreset(ctx, {
        name: 'Bad',
        entries: [{ id: 'e', days: ['noday'], time: '03:00' }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(RebootPresetValidationError);
  });
});

describe('updateRebootPreset — built-in override path', () => {
  it('uses setDoc({merge: true}) and pins isBuiltIn:true', async () => {
    const result = await updateRebootPreset(ctx, 'builtin-weekly-reboot', {
      name: 'Weekly reboot (custom)',
    });
    expect(result.isBuiltInOverride).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.isBuiltIn).toBe(true);
    expect(setCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
    expect(updateCalls).toHaveLength(0);
  });
});

describe('updateRebootPreset — custom edit path', () => {
  it('uses updateDoc when the preset exists', async () => {
    docState.set('config/site-a/reboot_presets/reboot-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });
    const result = await updateRebootPreset(ctx, 'reboot-custom-1', { name: 'new name' });
    expect(result.isBuiltInOverride).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.name).toBe('new name');
  });

  it('throws RebootPresetNotFoundError when missing', async () => {
    await expect(
      updateRebootPreset(ctx, 'reboot-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(RebootPresetNotFoundError);
  });

  it('rejects empty body', async () => {
    await expect(
      updateRebootPreset(ctx, 'reboot-x-1', {}),
    ).rejects.toBeInstanceOf(RebootPresetValidationError);
  });
});

describe('deleteRebootPreset', () => {
  it('deletes an existing preset', async () => {
    docState.set('config/site-a/reboot_presets/reboot-x-1', {
      exists: true,
      data: () => ({ name: 'x' }),
    });
    const result = await deleteRebootPreset(ctx, 'reboot-x-1');
    expect(result.presetId).toBe('reboot-x-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('treats missing docs as a successful idempotent delete', async () => {
    const result = await deleteRebootPreset(ctx, 'reboot-missing-1');
    expect(result.presetId).toBe('reboot-missing-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects invalid preset id', async () => {
    await expect(
      deleteRebootPreset(ctx, 'bad id'),
    ).rejects.toBeInstanceOf(RebootPresetValidationError);
  });
});
