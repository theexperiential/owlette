/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/deleteDistribution.server.ts`
 * (security-boundary-migration wave 3.4).
 *
 * Tests cover:
 *   - 404 when the distribution doc doesn't exist
 *   - 409 (distribution_in_flight) when status is non-terminal
 *   - 409 defense-in-depth when any target is still pre-flight
 *     (even if parent status looks terminal)
 *   - happy path: delete + audit emission for every terminal status
 */

const noopBuildCollection = (): Record<string, unknown> => ({
  doc: jest.fn(() => ({
    delete: jest.fn(),
    get: jest.fn(async () => ({ exists: false, data: () => undefined })),
    collection: noopBuildCollection,
  })),
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: noopBuildCollection }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

import { deleteDistribution } from '@/lib/actions/deleteDistribution.server';
import { emitMutation } from '@/lib/auditLogClient';

type FakeFirestore = NonNullable<Parameters<typeof deleteDistribution>[0]['db']>;

interface RecordedDelete {
  path: string[];
}

function buildFakeDb(distData: Record<string, unknown> | null) {
  const deletes: RecordedDelete[] = [];

  function makeCollection(parentPath: string[]): { doc: (id: string) => unknown } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        return {
          delete: jest.fn(async () => {
            deletes.push({ path: docPath });
          }),
          get: jest.fn(async () => {
            if (
              docPath.length === 4 &&
              docPath[0] === 'sites' &&
              docPath[2] === 'project_distributions'
            ) {
              return {
                exists: distData !== null,
                data: () => distData ?? undefined,
              };
            }
            return { exists: false, data: () => undefined };
          }),
          collection: (name: string) => makeCollection([...docPath, name]),
        };
      },
    };
  }

  const db = { collection: (name: string) => makeCollection([name]) };
  return { db: db as unknown as FakeFirestore, deletes };
}

const baseCtx = {
  siteId: 'site_a',
  distributionId: 'project-dist-1700000000000',
  actorIdentifier: 'user:user_1',
  correlationId: 'corr_delete',
};

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  error paths                                                               */
/* -------------------------------------------------------------------------- */

describe('deleteDistribution — error paths', () => {
  it('returns not_found when distribution doc does not exist', async () => {
    const { db, deletes } = buildFakeDb(null);
    const result = await deleteDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
    expect(deletes).toHaveLength(0);
  });

  it('returns distribution_in_flight when status is in_progress', async () => {
    const { db, deletes } = buildFakeDb({
      status: 'in_progress',
      targets: [{ machineId: 'm1', status: 'downloading' }],
    });
    const result = await deleteDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('distribution_in_flight');
    expect(result.details).toMatchObject({ status: 'in_progress' });
    expect(deletes).toHaveLength(0);
  });

  it('returns distribution_in_flight when status is pending', async () => {
    const { db } = buildFakeDb({
      status: 'pending',
      targets: [{ machineId: 'm1', status: 'pending' }],
    });
    const result = await deleteDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('distribution_in_flight');
  });

  it('refuses delete when parent looks terminal but a target is still pre-flight', async () => {
    // Defense in depth — reconciler drift could leave the parent status
    // ahead of its targets. The action should refuse rather than orphan
    // a pending target.
    const { db, deletes } = buildFakeDb({
      status: 'completed',
      targets: [
        { machineId: 'm1', status: 'completed' },
        { machineId: 'm2', status: 'pending' }, // still pre-flight
      ],
    });
    const result = await deleteDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('distribution_in_flight');
    expect(result.details).toMatchObject({
      status: 'completed',
      target_status: 'pending',
      target_machine_id: 'm2',
    });
    expect(deletes).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  happy paths — every terminal status                                       */
/* -------------------------------------------------------------------------- */

describe('deleteDistribution — terminal-status delete', () => {
  it.each(['completed', 'failed', 'partial', 'cancelled'])(
    'deletes when distribution status is %s',
    async (status) => {
      const { db, deletes } = buildFakeDb({
        status,
        targets: [{ machineId: 'm1', status: 'completed' }],
      });
      const result = await deleteDistribution({ ...baseCtx, db });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.distributionId).toBe(baseCtx.distributionId);
      expect(deletes).toHaveLength(1);
      expect(deletes[0].path).toEqual([
        'sites',
        'site_a',
        'project_distributions',
        baseCtx.distributionId,
      ]);
    },
  );

  it('emits distribution_mutated audit event on successful delete', async () => {
    const { db } = buildFakeDb({
      status: 'completed',
      targets: [{ machineId: 'm1', status: 'completed' }],
    });
    await deleteDistribution({ ...baseCtx, db });
    expect(emitMutation).toHaveBeenCalledTimes(1);
    const call = (emitMutation as jest.Mock).mock.calls[0][0];
    expect(call.kind).toBe('distribution_mutated');
    expect(call.siteId).toBe('site_a');
    expect(call.actor).toBe('user:user_1');
    expect(call.targetId).toBe(baseCtx.distributionId);
    expect(call.attributes.verb).toBe('delete');
    expect(call.attributes.method).toBe('DELETE');
    expect(call.attributes.prior_status).toBe('completed');
    expect(call.attributes.correlationId).toBe('corr_delete');
  });

  it('does not emit audit event on a refused delete', async () => {
    const { db } = buildFakeDb({
      status: 'in_progress',
      targets: [{ machineId: 'm1', status: 'downloading' }],
    });
    await deleteDistribution({ ...baseCtx, db });
    expect(emitMutation).not.toHaveBeenCalled();
  });
});
