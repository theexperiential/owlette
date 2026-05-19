/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/createDistribution.server.ts`
 * (security-boundary-migration wave 3.4).
 *
 * The action is the single source of truth for project-distribution
 * create logic. Tests cover:
 *   - validation (every failure code surfaces correctly)
 *   - per-site quota enforcement
 *   - distribution doc shape (firestore.rules required fields)
 *   - fan-out with `distribute_project` commands
 *   - parent-status flip to `in_progress`
 *
 * Mocks the firebase-admin Firestore at the doc-ref level — same pattern
 * `fanOut.test.ts` uses — so we can assert exact paths + payloads without
 * the emulator. `emitMutation` is mocked to a no-op (fire-and-forget).
 */

import { Timestamp } from 'firebase-admin/firestore';

const defaultSetMock = jest.fn().mockResolvedValue(undefined);
const defaultUpdateMock = jest.fn().mockResolvedValue(undefined);
const defaultGetMock = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
const defaultBuildCollection = (): Record<string, unknown> => ({
  doc: jest.fn(() => ({
    set: defaultSetMock,
    update: defaultUpdateMock,
    get: defaultGetMock,
    collection: defaultBuildCollection,
  })),
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: defaultBuildCollection }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

import {
  createDistribution,
  DEFAULT_DISTRIBUTION_MAX_TARGETS,
  type CreateDistributionInput,
} from '@/lib/actions/createDistribution.server';
import { emitMutation } from '@/lib/auditLogClient';

type FakeFirestore = NonNullable<Parameters<typeof createDistribution>[1]['db']>;

interface RecordedSet {
  path: string[];
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}
interface RecordedUpdate {
  path: string[];
  payload: Record<string, unknown>;
}

/**
 * Build a fake Firestore that records every `.set()` / `.update()` call
 * and exposes the exact paths so tests can assert what was written. The
 * site doc snapshot for the quota lookup is configured per test.
 */
function buildFakeDb(siteData: Record<string, unknown> | null = null) {
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
            // Site doc lookup is the only `.get()` callsite the action makes
            // outside of fan-out (fan-out doesn't read).
            if (
              docPath.length === 2 &&
              docPath[0] === 'sites' &&
              docPath[1] === ctx.siteId
            ) {
              return {
                exists: siteData !== null,
                data: () => siteData ?? undefined,
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
  return {
    db: db as unknown as FakeFirestore,
    sets,
    updates,
  };
}

const ctx = {
  siteId: 'site_a',
  actorIdentifier: 'user:user_1',
  correlationId: 'corr_1',
  now: () => 1_700_000_000_000,
};

const validInput: CreateDistributionInput = {
  name: 'sample distribution',
  file_name: 'project.zip',
  project_url: 'https://cdn.example.com/project.zip',
  machines: ['m1', 'm2'],
};

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  validation                                                                */
/* -------------------------------------------------------------------------- */

describe('createDistribution — validation', () => {
  it('rejects missing name', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, name: '' },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_name');
  });

  it('rejects missing file_name', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, file_name: '' },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_file_name');
  });

  it('rejects missing project_url', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, project_url: '' },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_project_url');
  });

  it('rejects malformed project_url', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, project_url: 'not a url' },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_project_url');
  });

  it('rejects http (non-https) project_url', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, project_url: 'http://cdn.example.com/p.zip' },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('project_url_not_https');
  });

  it('rejects non-string extract_path', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, extract_path: 123 as unknown as string },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_extract_path');
  });

  it('rejects malformed verify_files', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, verify_files: ['ok', '' as string] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_verify_files');
  });

  it('rejects empty machines array', async () => {
    const { db } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, machines: [] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_machines');
  });

  it('de-duplicates machine ids', async () => {
    const { db, sets } = buildFakeDb({});
    const result = await createDistribution(
      { ...validInput, machines: ['m1', 'm1', 'm2'] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targets).toHaveLength(2);
    // distribution doc + 2 machine pending docs (1 per unique machine)
    expect(sets.filter((s) => s.path.includes('project_distributions'))).toHaveLength(1);
    expect(sets.filter((s) => s.path.includes('pending'))).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  quota                                                                     */
/* -------------------------------------------------------------------------- */

describe('createDistribution — quota', () => {
  it('uses the default quota when sites doc is missing', async () => {
    const { db } = buildFakeDb(null);
    const machines = Array.from(
      { length: DEFAULT_DISTRIBUTION_MAX_TARGETS + 1 },
      (_, i) => `m${i}`,
    );
    const result = await createDistribution(
      { ...validInput, machines },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('over_quota');
    expect(result.details).toEqual({
      max_targets: DEFAULT_DISTRIBUTION_MAX_TARGETS,
      requested: machines.length,
    });
  });

  it('reads override from sites/{siteId}.distributionQuota', async () => {
    const { db } = buildFakeDb({ distributionQuota: 3 });
    const result = await createDistribution(
      { ...validInput, machines: ['m1', 'm2', 'm3', 'm4'] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('over_quota');
    expect(result.details).toEqual({ max_targets: 3, requested: 4 });
  });

  it('accepts a count exactly at the quota', async () => {
    const { db } = buildFakeDb({ distributionQuota: 2 });
    const result = await createDistribution(
      { ...validInput, machines: ['m1', 'm2'] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(true);
  });

  it('falls back to default when distributionQuota is non-numeric', async () => {
    const { db } = buildFakeDb({ distributionQuota: 'huge' });
    const result = await createDistribution(
      { ...validInput, machines: ['m1', 'm2'] },
      { ...ctx, db },
    );
    expect(result.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  happy path / fan-out                                                      */
/* -------------------------------------------------------------------------- */

describe('createDistribution — happy path', () => {
  it('writes the distribution doc with required fields', async () => {
    const { db, sets } = buildFakeDb({});
    const result = await createDistribution(validInput, { ...ctx, db });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const distSet = sets.find((s) => s.path.includes('project_distributions'));
    expect(distSet).toBeDefined();
    if (!distSet) return;
    expect(distSet.path).toEqual([
      'sites',
      'site_a',
      'project_distributions',
      result.distributionId,
    ]);
    // firestore.rules required fields
    expect(distSet.payload.name).toBe('sample distribution');
    expect(distSet.payload.file_name).toBe('project.zip');
    expect(distSet.payload.targets).toEqual([
      { machineId: 'm1', status: 'pending' },
      { machineId: 'm2', status: 'pending' },
    ]);
    expect(distSet.payload.status).toBe('pending');
    expect(distSet.payload.createdAt).toBeDefined();
    expect(distSet.payload.auditCorrelationId).toBe('corr_1');
    expect(distSet.payload.createdBy).toBe('user:user_1');
  });

  it('omits extract_path and verify_files when not provided', async () => {
    const { db, sets } = buildFakeDb({});
    await createDistribution(validInput, { ...ctx, db });
    const distSet = sets.find((s) => s.path.includes('project_distributions'));
    expect(distSet).toBeDefined();
    if (!distSet) return;
    expect(distSet.payload.extract_path).toBeUndefined();
    expect(distSet.payload.verify_files).toBeUndefined();
    // (not just === undefined — the keys should not be on the object)
    expect(Object.prototype.hasOwnProperty.call(distSet.payload, 'extract_path')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(distSet.payload, 'verify_files')).toBe(false);
  });

  it('includes extract_path and verify_files when provided', async () => {
    const { db, sets } = buildFakeDb({});
    await createDistribution(
      {
        ...validInput,
        extract_path: 'C:/Projects/sample',
        verify_files: ['main.toe', 'config.json'],
      },
      { ...ctx, db },
    );
    const distSet = sets.find((s) => s.path.includes('project_distributions'));
    if (!distSet) throw new Error('expected distribution set call');
    expect(distSet.payload.extract_path).toBe('C:/Projects/sample');
    expect(distSet.payload.verify_files).toEqual(['main.toe', 'config.json']);
  });

  it('fans out distribute_project to every target', async () => {
    const { db, sets } = buildFakeDb({});
    await createDistribution(validInput, { ...ctx, db });

    const fanOutSets = sets.filter((s) => s.path[s.path.length - 1] === 'pending');
    expect(fanOutSets).toHaveLength(2);

    for (const fanOut of fanOutSets) {
      expect(fanOut.options).toEqual({ merge: true });
      const [commandId] = Object.keys(fanOut.payload);
      expect(commandId.startsWith('distribute_project_dist_')).toBe(true);
      const cmd = fanOut.payload[commandId] as Record<string, unknown>;
      expect(cmd.type).toBe('distribute_project');
      expect(cmd.project_url).toBe(validInput.project_url);
      expect(cmd.project_name).toBe('project.zip');
      expect(cmd.distribution_id).toMatch(/^project-dist-/);
      expect(cmd.status).toBe('pending');
      // wave-2.2 fan-out attaches correlation id under metadata
      const meta = cmd.metadata as Record<string, unknown>;
      expect(meta.auditCorrelationId).toBe('corr_1');
      // lifecycle stamping
      expect(cmd.expiresAt).toBeInstanceOf(Timestamp);
    }
  });

  it('flips parent status to in_progress after fan-out', async () => {
    const { db, updates } = buildFakeDb({});
    const result = await createDistribution(validInput, { ...ctx, db });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const distUpdate = updates.find((u) =>
      u.path.includes('project_distributions'),
    );
    expect(distUpdate).toBeDefined();
    if (!distUpdate) return;
    expect(distUpdate.payload).toEqual({ status: 'in_progress' });
  });

  it('emits distribution_mutated audit event with correlation id', async () => {
    const { db } = buildFakeDb({});
    await createDistribution(validInput, { ...ctx, db });
    expect(emitMutation).toHaveBeenCalledTimes(1);
    const call = (emitMutation as jest.Mock).mock.calls[0][0];
    expect(call.kind).toBe('distribution_mutated');
    expect(call.siteId).toBe('site_a');
    expect(call.actor).toBe('user:user_1');
    expect(call.attributes.endpoint).toBe('/api/sites/site_a/project-distributions');
    expect(call.attributes.method).toBe('POST');
    expect(call.attributes.verb).toBe('create');
    expect(call.attributes.target_count).toBe(2);
    expect(call.attributes.file_name).toBe('project.zip');
    expect(call.attributes.correlationId).toBe('corr_1');
  });
});
