/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/cancelDistribution.server.ts`
 * (security-boundary-migration wave 3.4).
 *
 * Tests cover:
 *   - 404 when the distribution doc doesn't exist
 *   - 409 (no_cancellable_targets) when every target is terminal
 *   - target-level status flips on mixed-status targets
 *   - parent-status recompute when all targets become terminal
 *   - purge of queued `distribute_project` commands from machine pending docs
 *   - fan-out of `cancel_distribution` to short-circuit mid-fetch agents
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

const noopBuildCollection = (): Record<string, unknown> => ({
  doc: jest.fn(() => ({
    set: jest.fn(),
    update: jest.fn(),
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

import { cancelDistribution } from '@/lib/actions/cancelDistribution.server';
import { emitMutation } from '@/lib/auditLogClient';

type FakeFirestore = NonNullable<Parameters<typeof cancelDistribution>[0]['db']>;

interface RecordedSet {
  path: string[];
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}
interface RecordedUpdate {
  path: string[];
  payload: Record<string, unknown>;
}

interface FixtureOptions {
  /** distribution doc data — `null` means the doc does not exist. */
  distData: Record<string, unknown> | null;
  /** Per-machine pending-doc data, keyed by machineId. */
  pending?: Record<string, Record<string, unknown>>;
}

function buildFakeDb(opts: FixtureOptions) {
  const sets: RecordedSet[] = [];
  const updates: RecordedUpdate[] = [];

  function makeCollection(parentPath: string[]): { doc: (id: string) => unknown } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        return {
          set: jest.fn(
            async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
              sets.push({ path: docPath, payload, options });
            },
          ),
          update: jest.fn(async (payload: Record<string, unknown>) => {
            updates.push({ path: docPath, payload });
          }),
          get: jest.fn(async () => {
            // Distribution doc lookup
            if (
              docPath.length === 4 &&
              docPath[0] === 'sites' &&
              docPath[2] === 'project_distributions'
            ) {
              return {
                exists: opts.distData !== null,
                data: () => opts.distData ?? undefined,
              };
            }
            // Machine pending-doc lookup
            if (
              docPath.length === 6 &&
              docPath[2] === 'machines' &&
              docPath[4] === 'commands' &&
              docPath[5] === 'pending'
            ) {
              const machineId = docPath[3];
              const data = opts.pending?.[machineId];
              return {
                exists: !!data,
                data: () => data,
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
  return { db: db as unknown as FakeFirestore, sets, updates };
}

const baseCtx = {
  siteId: 'site_a',
  distributionId: 'project-dist-1700000000000',
  actorIdentifier: 'user:user_1',
  correlationId: 'corr_cancel',
  now: () => 1_700_000_001_000,
};

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  error paths                                                               */
/* -------------------------------------------------------------------------- */

describe('cancelDistribution — error paths', () => {
  it('returns not_found when distribution doc does not exist', async () => {
    const { db } = buildFakeDb({ distData: null });
    const result = await cancelDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
  });

  it('returns no_cancellable_targets when every target is terminal', async () => {
    const { db, updates } = buildFakeDb({
      distData: {
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'failed' },
          { machineId: 'm3', status: 'cancelled' },
        ],
        status: 'partial',
      },
    });
    const result = await cancelDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_cancellable_targets');
    expect(updates).toHaveLength(0); // no writes
  });
});

/* -------------------------------------------------------------------------- */
/*  happy paths — mixed status                                                */
/* -------------------------------------------------------------------------- */

describe('cancelDistribution — mixed-status targets', () => {
  it('cancels pre-flight targets and leaves terminal targets untouched', async () => {
    const { db, updates } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [
          { machineId: 'm1', status: 'pending' },
          { machineId: 'm2', status: 'downloading' },
          { machineId: 'm3', status: 'completed' },
        ],
        status: 'in_progress',
      },
    });
    const result = await cancelDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toBe(2);
    expect(result.machine_ids).toEqual(['m1', 'm2']);
    // m3 was completed, not all-terminal yet because nextStatus calc
    // sees a mix of cancelled + completed → 'partial'.
    expect(result.status).toBe('partial');

    const distUpdate = updates.find((u) =>
      u.path.includes('project_distributions'),
    );
    expect(distUpdate).toBeDefined();
    if (!distUpdate) return;
    const updatedTargets = distUpdate.payload.targets as Array<{
      machineId: string;
      status: string;
      cancelledAt?: unknown;
    }>;
    expect(updatedTargets[0]).toMatchObject({ machineId: 'm1', status: 'cancelled' });
    expect(updatedTargets[1]).toMatchObject({ machineId: 'm2', status: 'cancelled' });
    expect(updatedTargets[2]).toMatchObject({ machineId: 'm3', status: 'completed' });
    // Wall-clock Timestamp on cancelled targets (not serverTimestamp sentinel
    // because Firestore rejects sentinels inside array elements).
    expect(updatedTargets[0].cancelledAt).toBeInstanceOf(Timestamp);
  });

  it('extracting status counts as pre-flight', async () => {
    const { db } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [{ machineId: 'm1', status: 'extracting' }],
        status: 'in_progress',
      },
    });
    const result = await cancelDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toBe(1);
  });

  it('flips parent status to cancelled when every target becomes cancelled', async () => {
    const { db, updates } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [
          { machineId: 'm1', status: 'pending' },
          { machineId: 'm2', status: 'pending' },
        ],
        status: 'in_progress',
      },
    });
    const result = await cancelDistribution({ ...baseCtx, db });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('cancelled');

    const distUpdate = updates.find((u) =>
      u.path.includes('project_distributions'),
    );
    expect(distUpdate).toBeDefined();
    if (!distUpdate) return;
    expect(distUpdate.payload.status).toBe('cancelled');
    expect(distUpdate.payload.completedAt).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  side effects                                                              */
/* -------------------------------------------------------------------------- */

describe('cancelDistribution — side effects', () => {
  it('purges queued distribute_project commands from each cancellable machine', async () => {
    const { db, updates } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [{ machineId: 'm1', status: 'pending' }],
        status: 'in_progress',
      },
      pending: {
        m1: {
          'distribute_dist1_m1_111': {
            type: 'distribute_project',
            distribution_id: baseCtx.distributionId,
          },
          'install_dep_m1_222': {
            type: 'install_software',
            deployment_id: 'deploy-9',
          },
          'distribute_dist2_m1_333': {
            type: 'distribute_project',
            distribution_id: 'project-dist-other',
          },
        },
      },
    });
    await cancelDistribution({ ...baseCtx, db });
    // Pending-doc updates: only the matching distribute_project entry is purged.
    const pendingUpdate = updates.find((u) => u.path[u.path.length - 1] === 'pending');
    expect(pendingUpdate).toBeDefined();
    if (!pendingUpdate) return;
    const keys = Object.keys(pendingUpdate.payload);
    expect(keys).toEqual(['distribute_dist1_m1_111']);
    // FieldValue.delete() sentinel
    expect(pendingUpdate.payload['distribute_dist1_m1_111']).toBe(FieldValue.delete());
  });

  it('fans out cancel_distribution to every cancellable target', async () => {
    const { db, sets } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [
          { machineId: 'm1', status: 'pending' },
          { machineId: 'm2', status: 'downloading' },
          { machineId: 'm3', status: 'completed' }, // not cancellable
        ],
        status: 'in_progress',
      },
    });
    await cancelDistribution({ ...baseCtx, db });
    const fanOutSets = sets.filter((s) => s.path[s.path.length - 1] === 'pending');
    expect(fanOutSets).toHaveLength(2);
    const fanOutMachineIds = fanOutSets.map((s) => s.path[3]);
    expect(fanOutMachineIds).toEqual(['m1', 'm2']);
    for (const fanOut of fanOutSets) {
      const [commandId] = Object.keys(fanOut.payload);
      expect(commandId.startsWith('cancel_')).toBe(true);
      const cmd = fanOut.payload[commandId] as Record<string, unknown>;
      expect(cmd.type).toBe('cancel_distribution');
      expect(cmd.project_name).toBe('project.zip');
      expect(cmd.distribution_id).toBe(baseCtx.distributionId);
      const meta = cmd.metadata as Record<string, unknown>;
      expect(meta.auditCorrelationId).toBe('corr_cancel');
    }
  });

  it('emits distribution_mutated audit event with cancel verb', async () => {
    const { db } = buildFakeDb({
      distData: {
        file_name: 'project.zip',
        targets: [{ machineId: 'm1', status: 'pending' }],
        status: 'in_progress',
      },
    });
    await cancelDistribution({ ...baseCtx, db });
    expect(emitMutation).toHaveBeenCalledTimes(1);
    const call = (emitMutation as jest.Mock).mock.calls[0][0];
    expect(call.kind).toBe('distribution_mutated');
    expect(call.attributes.verb).toBe('cancel');
    expect(call.attributes.cancelled_count).toBe(1);
    expect(call.attributes.machine_ids).toEqual(['m1']);
  });
});
