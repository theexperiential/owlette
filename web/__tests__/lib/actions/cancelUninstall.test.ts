/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/cancelUninstall.server.ts`
 * (security-boundary-migration wave 3.5).
 *
 * Covers:
 *   - input parsing + validation (`parseCancelUninstallInput`)
 *   - end-to-end cancel write against a fake firestore
 *   - command shape parity with the legacy client-side write in
 *     `web/hooks/useUninstall.ts:cancelUninstall` so the agent's existing
 *     `cmd_type == 'cancel_uninstall'` handler processes it identically.
 *
 * Authorization (capability + scope) is enforced by `authorizedSiteHandler`
 * in the route shim — those tests live alongside the route integration.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

import {
  cancelUninstall,
  parseCancelUninstallInput,
  CancelUninstallError,
} from '@/lib/actions/cancelUninstall.server';

/* ── fake firestore (machine-doc + pending-set only) ──────────────────── */

interface SetCall {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface FakeDbState {
  setCalls: SetCall[];
  setMachine: (data: Record<string, unknown> | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(): FakeDbState {
  const setCalls: SetCall[] = [];
  let machineData: Record<string, unknown> | null = { online: true };

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        if (
          docPath.startsWith('sites/') &&
          docPath.includes('/machines/') &&
          !docPath.includes('/commands/')
        ) {
          if (machineData === null) return { exists: false, data: () => undefined };
          return { exists: true, data: () => machineData };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (
        payload: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        setCalls.push({ path: docPath, payload, options });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return { doc: (id: string) => makeDocRef(`${colPath}/${id}`) };
  }

  const db = { collection: (name: string) => makeCollectionRef(name) };

  return {
    setCalls,
    setMachine: (data) => {
      machineData = data;
    },
    db,
  };
}

/* ── parseCancelUninstallInput ────────────────────────────────────────── */

describe('parseCancelUninstallInput', () => {
  it('accepts a minimal valid payload', () => {
    expect(parseCancelUninstallInput({ software_name: 'TD' })).toEqual({
      software_name: 'TD',
    });
  });

  it('trims whitespace from software_name', () => {
    expect(parseCancelUninstallInput({ software_name: '  TD  ' })).toEqual({
      software_name: 'TD',
    });
  });

  it('rejects a non-object body', () => {
    expect(() => parseCancelUninstallInput(null)).toThrow(CancelUninstallError);
    expect(() => parseCancelUninstallInput([1])).toThrow(CancelUninstallError);
    expect(() => parseCancelUninstallInput('hi')).toThrow(CancelUninstallError);
  });

  it('rejects missing software_name', () => {
    expect(() => parseCancelUninstallInput({})).toThrow(/software_name/);
  });

  it('rejects empty software_name', () => {
    expect(() => parseCancelUninstallInput({ software_name: '   ' })).toThrow(
      /software_name/,
    );
  });

  it('rejects software_name longer than 256 chars', () => {
    const longName = 'x'.repeat(257);
    expect(() => parseCancelUninstallInput({ software_name: longName })).toThrow(
      /256/,
    );
  });
});

/* ── cancelUninstall (action core) ────────────────────────────────────── */

describe('cancelUninstall — input guards', () => {
  it('throws when siteId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      cancelUninstall('', 'm1', { software_name: 'TD' }, { db: fake.db }),
    ).rejects.toThrow(/siteId/);
    expect(fake.setCalls).toHaveLength(0);
  });

  it('throws when machineId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      cancelUninstall('site-a', '', { software_name: 'TD' }, { db: fake.db }),
    ).rejects.toThrow(/machineId/);
    expect(fake.setCalls).toHaveLength(0);
  });

  it('returns machine_not_found when machine doc is absent', async () => {
    const fake = buildFakeDb();
    fake.setMachine(null);
    await expect(
      cancelUninstall(
        'site-a',
        'm1',
        { software_name: 'TD' },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      name: 'CancelUninstallError',
      code: 'machine_not_found',
    });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('writes the cancel command even when machine is offline (no online gate)', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: false });
    const result = await cancelUninstall(
      'site-a',
      'm1',
      { software_name: 'TD' },
      { db: fake.db, now: () => 5 },
    );
    expect(result.status).toBe('pending');
    expect(fake.setCalls).toHaveLength(1);
  });
});

/* ── command write shape parity with useUninstall.ts:cancelUninstall ──── */

describe('cancelUninstall — command write shape', () => {
  it('writes the canonical cancel_uninstall payload with lifecycle stamps', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    const result = await cancelUninstall(
      'site-alpha',
      'mach_pi',
      { software_name: 'TouchDesigner 2025' },
      {
        db: fake.db,
        now: () => 1_700_000_000_000,
        auditCorrelationId: 'corr_xyz',
      },
    );

    expect(fake.setCalls).toHaveLength(1);
    const call = fake.setCalls[0];
    expect(call.path).toBe('sites/site-alpha/machines/mach_pi/commands/pending');
    expect(call.options).toEqual({ merge: true });

    const keys = Object.keys(call.payload);
    expect(keys).toHaveLength(1);
    const commandId = keys[0];
    expect(commandId).toBe('cancel-uninstall-1700000000000');
    expect(commandId).toBe(result.commandId);

    const entry = call.payload[commandId] as Record<string, unknown>;
    // Legacy client-side fields — preserve bit-for-bit so the agent's
    // existing cancel_uninstall handler matches by software_name.
    expect(entry.type).toBe('cancel_uninstall');
    expect(entry.software_name).toBe('TouchDesigner 2025');
    expect(entry.timestamp).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    // Lifecycle stamps from stampCommand.
    expect(entry.createdAt).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.expiresAt).toBeInstanceOf(Timestamp);
    expect(entry.auditCorrelationId).toBe('corr_xyz');
  });

  it('omits auditCorrelationId when not provided', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    await cancelUninstall(
      'site-a',
      'm1',
      { software_name: 'TD' },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(entry, 'auditCorrelationId')).toBe(
      false,
    );
  });

  it('returns a result echoing the inputs and the synthesized commandId', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    const result = await cancelUninstall(
      'site-with_dashes-and_underscores',
      'mach_42-x',
      { software_name: 'Resolume Arena' },
      { db: fake.db, now: () => 999 },
    );
    expect(result).toEqual({
      siteId: 'site-with_dashes-and_underscores',
      machineId: 'mach_42-x',
      software_name: 'Resolume Arena',
      commandId: 'cancel-uninstall-999',
      status: 'pending',
    });
  });
});
