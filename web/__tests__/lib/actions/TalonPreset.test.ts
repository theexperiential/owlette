/** @jest-environment node */

/**
 * Tests for the talon preset action cores
 * (web/lib/actions/{create,update,delete}TalonPreset.server.ts).
 *
 * Same harness as `RestartPreset.test.ts` — the fifth preset family behaves
 * identically at the storage layer, and the tests say so. What is new here is
 * the delegated validation: the template goes through the real talon
 * validator, so this file also pins that a preset can never store a talon the
 * talons API would refuse.
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

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

import {
  createTalonPreset,
  TalonPresetValidationError,
} from '@/lib/actions/createTalonPreset.server';
import {
  updateTalonPreset,
  TalonPresetNotFoundError,
} from '@/lib/actions/updateTalonPreset.server';
import { deleteTalonPreset } from '@/lib/actions/deleteTalonPreset.server';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

const ctx: SiteHandlerContext = {
  actor: { type: 'user', userId: 'uid_alice', role: 'admin', sites: ['site-a'] },
  siteId: 'site-a',
  correlationId: 'cid_1',
  auth: { userId: 'uid_alice', keyContext: null },
  scopeCheck: { isLegacy: false },
};

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'morning wall check',
    trigger: { type: 'event', eventTypes: ['process_crash'] },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

function presetInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'morning wall check',
    template: template(),
    isBuiltIn: false,
    order: 100,
    createdBy: 'uid_alice',
    ...overrides,
  };
}

async function expectValidationError(
  promise: Promise<unknown>,
  field: string,
): Promise<TalonPresetValidationError> {
  await expect(promise).rejects.toBeInstanceOf(TalonPresetValidationError);
  return promise.catch((error: TalonPresetValidationError) => {
    expect(error.field).toBe(field);
    return error;
  }) as Promise<TalonPresetValidationError>;
}

beforeEach(() => {
  setCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  docState.clear();
  mockEmitMutation.mockClear();
});

describe('createTalonPreset', () => {
  it('creates a preset under config/{siteId}/talon_presets', async () => {
    const result = await createTalonPreset(ctx, presetInput());

    expect(result.siteId).toBe('site-a');
    expect(result.presetId).toMatch(/^talon-morning-wall-check-\d+$/);

    expect(setCalls).toHaveLength(1);
    const call = setCalls[0];
    expect(call.path.startsWith('config/site-a/talon_presets/talon-morning-wall-check-')).toBe(true);
    expect(call.merge).toBeUndefined();
    expect(call.payload.name).toBe('morning wall check');
    expect(call.payload.isBuiltIn).toBe(false);
    expect(call.payload.createdBy).toBe('uid_alice');
    expect(call.payload.createdAt).toBe('__SERVER_TS__');
  });

  it('persists the validator output, not the raw body', async () => {
    await createTalonPreset(
      ctx,
      presetInput({
        template: template({
          name: '  morning wall check  ',
          // Out of canonical order and duplicated — the validator de-dupes and
          // re-orders, and it is that value the preset must store.
          trigger: {
            type: 'event',
            eventTypes: ['process_start_failed', 'process_crash', 'process_crash'],
          },
        }),
      }),
    );

    expect(setCalls[0].payload.template).toEqual({
      name: 'morning wall check',
      trigger: { type: 'event', eventTypes: ['process_crash', 'process_start_failed'] },
      condition: { type: 'none' },
      outputs: [{ type: 'email' }],
      cooldownMinutes: 60,
    });
  });

  it('rejects a template carrying scope', async () => {
    await expectValidationError(
      createTalonPreset(ctx, presetInput({ template: template({ scope: { machineIds: ['m1'] } }) })),
      'template.scope',
    );
    expect(setCalls).toHaveLength(0);
  });

  it('rejects a template carrying enabled', async () => {
    await expectValidationError(
      createTalonPreset(ctx, presetInput({ template: template({ enabled: false }) })),
      'template.enabled',
    );
  });

  it('delegates to the talon validator and prefixes the failure', async () => {
    const error = await expectValidationError(
      createTalonPreset(ctx, presetInput({ template: template({ outputs: [] }) })),
      'template.outputs',
    );
    expect(error.fieldErrors).toEqual([
      { field: 'template.outputs', code: 'out_of_range', message: 'add at least one output' },
    ]);
  });

  it('refuses a command output with no process target', async () => {
    // The blocker the templates depend on: without it a preset can store a
    // talon that fails every run until the auto-disable at ten failures.
    const error = await expectValidationError(
      createTalonPreset(
        ctx,
        presetInput({
          template: template({ outputs: [{ type: 'command', commandType: 'restart_process' }] }),
        }),
      ),
      'template.outputs[0].processId',
    );
    expect(error.message).toBe('choose a process');
  });

  it('rejects a missing name', async () => {
    await expectValidationError(
      createTalonPreset(ctx, presetInput({ name: '   ' })),
      'name',
    );
  });

  it('rejects a non-object template', async () => {
    await expectValidationError(
      createTalonPreset(ctx, presetInput({ template: 'nope' })),
      'template',
    );
  });
});

describe('updateTalonPreset — built-in override path', () => {
  it('uses set({merge: true}) and pins isBuiltIn:true', async () => {
    const result = await updateTalonPreset(ctx, 'builtin-morning-wall-check', {
      name: 'morning wall check (ours)',
    });

    expect(result.isBuiltInOverride).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe('config/site-a/talon_presets/builtin-morning-wall-check');
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.isBuiltIn).toBe(true);
    expect(setCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
    expect(updateCalls).toHaveLength(0);
  });
});

describe('updateTalonPreset — custom edit path', () => {
  it('uses update() when the preset exists', async () => {
    docState.set('config/site-a/talon_presets/talon-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });

    const result = await updateTalonPreset(ctx, 'talon-custom-1', { name: 'new name' });
    expect(result.isBuiltInOverride).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.name).toBe('new name');
    // A name-only patch must not blank the template.
    expect(updateCalls[0].payload.template).toBeUndefined();
  });

  it('re-validates a supplied template', async () => {
    docState.set('config/site-a/talon_presets/talon-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });

    await expectValidationError(
      updateTalonPreset(ctx, 'talon-custom-1', {
        template: template({ trigger: { type: 'schedule', intervalMinutes: 1 } }),
      }),
      'template.trigger.intervalMinutes',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('throws TalonPresetNotFoundError when missing', async () => {
    await expect(
      updateTalonPreset(ctx, 'talon-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(TalonPresetNotFoundError);
  });

  it('rejects an empty body', async () => {
    await expectValidationError(updateTalonPreset(ctx, 'talon-x-1', {}), 'body');
  });

  it('rejects an invalid preset id', async () => {
    await expectValidationError(updateTalonPreset(ctx, 'bad id', { name: 'x' }), 'presetId');
  });
});

describe('deleteTalonPreset', () => {
  it('deletes an existing preset', async () => {
    docState.set('config/site-a/talon_presets/talon-x-1', {
      exists: true,
      data: () => ({ name: 'x' }),
    });
    const result = await deleteTalonPreset(ctx, 'talon-x-1');
    expect(result.presetId).toBe('talon-x-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('treats missing docs as a successful idempotent delete', async () => {
    const result = await deleteTalonPreset(ctx, 'talon-missing-1');
    expect(result.presetId).toBe('talon-missing-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects an invalid preset id', async () => {
    await expectValidationError(deleteTalonPreset(ctx, 'bad id'), 'presetId');
  });
});

describe('talon preset audit emission', () => {
  it('emits preset.create on create', async () => {
    const result = await createTalonPreset(ctx, presetInput());

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        // Reused, never a new kind: a preset is stored config and never
        // reaches a machine, so `talon_mutated` would misreport it.
        kind: 'process_mutated',
        siteId: 'site-a',
        actor: 'user:uid_alice',
        targetId: result.presetId,
        attributes: expect.objectContaining({
          verb: 'preset.create',
          endpoint: 'presets/talon',
          family: 'talon',
          presetId: result.presetId,
        }),
      }),
    );
  });

  it('emits preset.update on a built-in override', async () => {
    await updateTalonPreset(ctx, 'builtin-morning-wall-check', { name: 'renamed' });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'builtin-morning-wall-check',
        attributes: expect.objectContaining({
          verb: 'preset.update',
          family: 'talon',
          isBuiltInOverride: true,
        }),
      }),
    );
  });

  it('does not emit when the update target is missing', async () => {
    await expect(
      updateTalonPreset(ctx, 'talon-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(TalonPresetNotFoundError);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('does not emit when validation fails', async () => {
    await expect(
      createTalonPreset(ctx, presetInput({ template: template({ outputs: [] }) })),
    ).rejects.toBeInstanceOf(TalonPresetValidationError);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('emits preset.delete on delete', async () => {
    await deleteTalonPreset(ctx, 'talon-x-1');

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'talon-x-1',
        attributes: expect.objectContaining({
          verb: 'preset.delete',
          family: 'talon',
        }),
      }),
    );
  });
});
