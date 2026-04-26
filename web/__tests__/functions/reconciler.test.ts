/**
 * @jest-environment node
 *
 * Unit / integration tests for the listener-driven write reconcilers
 * (security-boundary-migration wave 2.4):
 *
 *   functions/src/reconcileDeploymentStatus.ts
 *   functions/src/reconcileDistributionStatus.ts
 *   functions/src/lib/reconcilerLogic.ts
 *
 * These tests do NOT boot the firestore emulator (wave 1.7 is the
 * harness for that). Instead, the firebase-admin SDK is mocked at the
 * module boundary so we can assert exactly which paths get read,
 * which paths get written, what payload shape lands, and whether a
 * replay short-circuits on idempotency.
 *
 * Coverage:
 *   - pure logic (status transitions, aggregation, idempotency check)
 *   - per-trigger handler (deployment + distribution)
 *   - end-to-end transitions: all-success / partial-failure / all-failure
 *     / in-progress / cancellation
 *   - idempotency: replay with same `auditCorrelationId` → no second
 *     parent-doc write, no second audit row
 *   - audit entry written for every reconciled allow-write
 */

// --- 1. firebase-admin mock ------------------------------------------------
//
// jest.mock() must run before any module-level import that pulls
// firebase-admin into scope, including the reconciler modules under test.
// We expose the per-document mocks on the module object so individual
// tests can stage doc data and inspect captured writes.

type DocSpec = {
  exists: boolean;
  data?: Record<string, unknown>;
};
type SetCall = { path: string; payload: Record<string, unknown> };
type UpdateCall = { path: string; payload: Record<string, unknown> };

const docFixtures = new Map<string, DocSpec>();
const updateCalls: UpdateCall[] = [];
const setCalls: SetCall[] = [];
let updateShouldReject: Error | null = null;
let auditDocCounter = 0;

function fakeDoc(path: string): unknown {
  return {
    get: async () => {
      const spec = docFixtures.get(path);
      if (!spec || !spec.exists) {
        return { exists: false, data: () => undefined };
      }
      return { exists: true, data: () => spec.data };
    },
    update: async (payload: Record<string, unknown>) => {
      if (updateShouldReject) throw updateShouldReject;
      updateCalls.push({ path, payload });
      // Reflect the write into the fixture so subsequent reads see it.
      const prev = docFixtures.get(path)?.data ?? {};
      docFixtures.set(path, { exists: true, data: { ...prev, ...payload } });
    },
    set: async (payload: Record<string, unknown>) => {
      setCalls.push({ path, payload });
    },
    collection: (sub: string) => fakeCollection(`${path}/${sub}`),
  };
}

function fakeCollection(path: string): unknown {
  return {
    doc: (id?: string) => {
      if (id === undefined) {
        // Auto-id — used by the audit writer.
        auditDocCounter += 1;
        return fakeDoc(`${path}/audit_auto_${auditDocCounter}`);
      }
      return fakeDoc(`${path}/${id}`);
    },
  };
}

const SERVER_TIMESTAMP_SENTINEL = '__serverTimestamp__';

// `firebase-admin`, `firebase-admin/firestore`, and
// `firebase-functions/v2/firestore` are not installed in `web/node_modules`
// (they live in `functions/node_modules`). Use `virtual: true` so jest
// resolves to our mock factory instead of trying to walk node_modules.
jest.mock(
  'firebase-admin',
  () => ({
    __esModule: true,
    default: {
      firestore: () => ({
        collection: (top: string) => fakeCollection(top),
      }),
    },
    firestore: () => ({
      collection: (top: string) => fakeCollection(top),
    }),
    initializeApp: jest.fn(),
  }),
  { virtual: true },
);

jest.mock(
  'firebase-admin/firestore',
  () => ({
    FieldValue: {
      serverTimestamp: () => SERVER_TIMESTAMP_SENTINEL,
    },
  }),
  { virtual: true },
);

// `firebase-functions/v2/firestore` only contributes the trigger
// registration helper; the handler bodies we test don't depend on it
// at runtime — we invoke them directly by reaching into the module's
// internal helper. Provide a stub so the import doesn't fail.
jest.mock(
  'firebase-functions/v2/firestore',
  () => ({
    onDocumentUpdated: (_path: string, handler: unknown) => handler,
  }),
  { virtual: true },
);

// --- 2. imports under test -------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
const reconcilerLogic = require(
  '../../../functions/src/lib/reconcilerLogic',
) as typeof import('../../../functions/src/lib/reconcilerLogic');
const reconcileDeploymentMod = require(
  '../../../functions/src/reconcileDeploymentStatus',
) as typeof import('../../../functions/src/reconcileDeploymentStatus');
const reconcileDistributionMod = require(
  '../../../functions/src/reconcileDistributionStatus',
) as typeof import('../../../functions/src/reconcileDistributionStatus');
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  diffCommandMap,
  groupByDeploymentId,
  groupByDistributionId,
  isAlreadyProcessed,
  mapDeploymentCommandStatus,
  mapDistributionCommandStatus,
  calculateDeploymentStatus,
  calculateDistributionStatus,
  reconcileDeployment,
  reconcileDistribution,
} = reconcilerLogic;

// Trigger functions are exported wrapped — our `onDocumentUpdated`
// stub above unwraps the handler back into a plain function for
// direct invocation.
const reconcileDeploymentHandler =
  reconcileDeploymentMod.reconcileDeploymentStatus as unknown as (
    event: unknown,
  ) => Promise<void>;
const reconcileDistributionHandler =
  reconcileDistributionMod.reconcileDistributionStatus as unknown as (
    event: unknown,
  ) => Promise<void>;

// --- 3. helpers ------------------------------------------------------------

const SITE = 'site-a';
const MACHINE_A = 'machine-a';
const MACHINE_B = 'machine-b';
const DEPLOY_ID = 'deploy-1';
const DIST_ID = 'dist-1';

beforeEach(() => {
  docFixtures.clear();
  updateCalls.length = 0;
  setCalls.length = 0;
  updateShouldReject = null;
  auditDocCounter = 0;
});

function deploymentPath(deploymentId = DEPLOY_ID): string {
  return `sites/${SITE}/deployments/${deploymentId}`;
}

function distributionPath(distId = DIST_ID): string {
  return `sites/${SITE}/project_distributions/${distId}`;
}

function seedDeployment(targets: Record<string, unknown>[], status = 'in_progress') {
  docFixtures.set(deploymentPath(), {
    exists: true,
    data: { status, targets },
  });
}

function seedDistribution(targets: Record<string, unknown>[], status = 'in_progress') {
  docFixtures.set(distributionPath(), {
    exists: true,
    data: { status, targets },
  });
}

function mkEvent(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  machineId = MACHINE_A,
) {
  return {
    params: { siteId: SITE, machineId },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  };
}

function auditCallsForSite(): SetCall[] {
  return setCalls.filter((c) =>
    c.path.startsWith(`sites/${SITE}/audit_log/`),
  );
}

function deploymentUpdates(): UpdateCall[] {
  return updateCalls.filter((c) => c.path === deploymentPath());
}

function distributionUpdates(): UpdateCall[] {
  return updateCalls.filter((c) => c.path === distributionPath());
}

/* ========================================================================== */
/*  Pure logic: diffCommandMap                                                */
/* ========================================================================== */

describe('diffCommandMap', () => {
  it('returns brand-new entries as changed', () => {
    const before = {};
    const after = { c1: { status: 'pending' } };
    expect(diffCommandMap(before, after)).toEqual([
      { cmdId: 'c1', before: undefined, after: { status: 'pending' } },
    ]);
  });

  it('returns entries whose status changed', () => {
    const before = { c1: { status: 'pending', auditCorrelationId: 'x' } };
    const after = { c1: { status: 'completed', auditCorrelationId: 'x' } };
    const changed = diffCommandMap(before, after);
    expect(changed).toHaveLength(1);
    expect(changed[0].after.status).toBe('completed');
  });

  it('returns entries whose progress changed (intermediate updates)', () => {
    const before = { c1: { status: 'downloading', progress: 10 } };
    const after = { c1: { status: 'downloading', progress: 50 } };
    expect(diffCommandMap(before, after)).toHaveLength(1);
  });

  it('ignores entries with no relevant change', () => {
    const before = { c1: { status: 'pending', deployment_id: 'd1' } };
    const after = { c1: { status: 'pending', deployment_id: 'd1' } };
    expect(diffCommandMap(before, after)).toEqual([]);
  });

  it('skips deletions (commands moved to commands/completed)', () => {
    const before = { c1: { status: 'completed' } };
    const after = {};
    expect(diffCommandMap(before, after)).toEqual([]);
  });

  it('detects auditCorrelationId rotation as a change', () => {
    const before = { c1: { status: 'completed', auditCorrelationId: 'a' } };
    const after = { c1: { status: 'completed', auditCorrelationId: 'b' } };
    expect(diffCommandMap(before, after)).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Pure logic: status mapping + aggregation                                  */
/* ========================================================================== */

describe('mapDeploymentCommandStatus', () => {
  it.each([
    ['downloading', 'install_software', 'downloading'],
    ['installing', 'install_software', 'installing'],
    ['closing_processes', 'install_software', 'closing_processes'],
    ['failed', 'install_software', 'failed'],
    ['cancelled', 'install_software', 'cancelled'],
    ['completed', 'install_software', 'completed'],
    ['completed', 'uninstall_software', 'uninstalled'],
  ])('%s + %s → %s', (status, type, expected) => {
    expect(mapDeploymentCommandStatus(status, type)).toBe(expected);
  });

  it('treats undefined status as pending', () => {
    expect(mapDeploymentCommandStatus(undefined, 'install_software')).toBe(
      'pending',
    );
  });
});

describe('mapDistributionCommandStatus', () => {
  it.each([
    ['downloading', 'downloading'],
    ['extracting', 'extracting'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed'],
  ])('%s → %s', (status, expected) => {
    expect(mapDistributionCommandStatus(status)).toBe(expected);
  });
});

describe('calculateDeploymentStatus', () => {
  it('empty targets → pending', () => {
    expect(calculateDeploymentStatus([])).toBe('pending');
  });

  it('any non-terminal target → in_progress', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'downloading' },
      ]),
    ).toBe('in_progress');
  });

  it('all completed → completed', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'completed' },
      ]),
    ).toBe('completed');
  });

  it('all failed → failed', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'failed' },
        { machineId: 'b', status: 'failed' },
      ]),
    ).toBe('failed');
  });

  it('mixed completed + failed → partial', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'failed' },
      ]),
    ).toBe('partial');
  });

  it('all cancelled → cancelled', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'cancelled' },
        { machineId: 'b', status: 'cancelled' },
      ]),
    ).toBe('cancelled');
  });

  it('cancellations do not poison an otherwise-successful rollout', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'completed' },
        { machineId: 'c', status: 'cancelled' },
      ]),
    ).toBe('completed');
  });

  it('all uninstalled → uninstalled', () => {
    expect(
      calculateDeploymentStatus([
        { machineId: 'a', status: 'uninstalled' },
        { machineId: 'b', status: 'uninstalled' },
      ]),
    ).toBe('uninstalled');
  });
});

describe('calculateDistributionStatus', () => {
  it('all completed → completed', () => {
    expect(
      calculateDistributionStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'completed' },
      ]),
    ).toBe('completed');
  });

  it('mixed completed + failed → partial', () => {
    expect(
      calculateDistributionStatus([
        { machineId: 'a', status: 'completed' },
        { machineId: 'b', status: 'failed' },
      ]),
    ).toBe('partial');
  });

  it('any non-terminal → in_progress', () => {
    expect(
      calculateDistributionStatus([
        { machineId: 'a', status: 'extracting' },
        { machineId: 'b', status: 'completed' },
      ]),
    ).toBe('in_progress');
  });
});

/* ========================================================================== */
/*  Pure logic: idempotency + reconcile()                                     */
/* ========================================================================== */

describe('isAlreadyProcessed', () => {
  it('returns false when target has no recorded correlation id', () => {
    expect(
      isAlreadyProcessed({}, { auditCorrelationId: 'corr-1' }),
    ).toBe(false);
  });

  it('returns false when command has no correlation id', () => {
    expect(
      isAlreadyProcessed(
        { lastProcessedCommandCorrelationId: 'corr-1' },
        {},
      ),
    ).toBe(false);
  });

  it('returns true when ids match exactly', () => {
    expect(
      isAlreadyProcessed(
        { lastProcessedCommandCorrelationId: 'corr-1' },
        { auditCorrelationId: 'corr-1' },
      ),
    ).toBe(true);
  });

  it('returns false when ids differ', () => {
    expect(
      isAlreadyProcessed(
        { lastProcessedCommandCorrelationId: 'corr-1' },
        { auditCorrelationId: 'corr-2' },
      ),
    ).toBe(false);
  });
});

describe('reconcileDeployment (pure)', () => {
  it('skips when machine is not in deployment targets', () => {
    const verdict = reconcileDeployment({
      deployment: { status: 'in_progress', targets: [{ machineId: 'other', status: 'pending' }] },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software' },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('skip');
    if (verdict.kind === 'skip') expect(verdict.reason).toBe('machine_not_targeted');
  });

  it('skips when correlation id matches lastProcessed (idempotent replay)', () => {
    const verdict = reconcileDeployment({
      deployment: {
        status: 'in_progress',
        targets: [
          {
            machineId: MACHINE_A,
            status: 'completed',
            lastProcessedCommandCorrelationId: 'corr-1',
          },
        ],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'completed',
            type: 'install_software',
            deployment_id: DEPLOY_ID,
            auditCorrelationId: 'corr-1',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('skip');
    if (verdict.kind === 'skip') expect(verdict.reason).toBe('already_processed');
  });

  it('does not downgrade a terminal target to an intermediate state', () => {
    const verdict = reconcileDeployment({
      deployment: {
        status: 'completed',
        targets: [{ machineId: MACHINE_A, status: 'completed' }],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'downloading',
            deployment_id: DEPLOY_ID,
            type: 'install_software',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('skip');
  });

  it('marks deployment terminal when last target completes', () => {
    const verdict = reconcileDeployment({
      deployment: {
        status: 'in_progress',
        targets: [
          { machineId: MACHINE_A, status: 'pending' },
          { machineId: MACHINE_B, status: 'completed' },
        ],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'completed',
            type: 'install_software',
            deployment_id: DEPLOY_ID,
            auditCorrelationId: 'corr-x',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('apply');
    if (verdict.kind === 'apply') {
      expect(verdict.status).toBe('completed');
      expect(verdict.becameTerminal).toBe(true);
      expect(verdict.targets[0]).toMatchObject({
        machineId: MACHINE_A,
        status: 'completed',
        lastProcessedCommandCorrelationId: 'corr-x',
      });
      expect(verdict.targets[0].progress).toBeUndefined();
    }
  });

  it('keeps deployment in_progress when one target fails but another is pending', () => {
    const verdict = reconcileDeployment({
      deployment: {
        status: 'in_progress',
        targets: [
          { machineId: MACHINE_A, status: 'downloading', progress: 50 },
          { machineId: MACHINE_B, status: 'pending' },
        ],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'failed',
            type: 'install_software',
            error: 'disk full',
            deployment_id: DEPLOY_ID,
            auditCorrelationId: 'corr-fail',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('apply');
    if (verdict.kind === 'apply') {
      expect(verdict.status).toBe('in_progress');
      expect(verdict.becameTerminal).toBe(false);
      expect(verdict.targets[0]).toMatchObject({ status: 'failed', error: 'disk full' });
    }
  });

  it('uses the latest command (by updatedAt) when multiple changes for same machine', () => {
    const verdict = reconcileDeployment({
      deployment: {
        status: 'in_progress',
        targets: [{ machineId: MACHINE_A, status: 'pending' }],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'downloading',
            type: 'install_software',
            deployment_id: DEPLOY_ID,
            updatedAt: 100,
            auditCorrelationId: 'corr-1',
          },
        },
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'completed',
            type: 'install_software',
            deployment_id: DEPLOY_ID,
            updatedAt: 200,
            auditCorrelationId: 'corr-2',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('apply');
    if (verdict.kind === 'apply') {
      expect(verdict.targets[0].status).toBe('completed');
      expect(verdict.correlationId).toBe('corr-2');
    }
  });
});

describe('reconcileDistribution (pure)', () => {
  it('skips when machine is not in distribution targets', () => {
    const verdict = reconcileDistribution({
      distribution: {
        status: 'in_progress',
        targets: [{ machineId: 'other', status: 'pending' }],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: { status: 'completed', distribution_id: DIST_ID },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('skip');
    if (verdict.kind === 'skip') expect(verdict.reason).toBe('machine_not_targeted');
  });

  it('marks distribution terminal when last target completes', () => {
    const verdict = reconcileDistribution({
      distribution: {
        status: 'in_progress',
        targets: [
          { machineId: MACHINE_A, status: 'extracting', progress: 60 },
          { machineId: MACHINE_B, status: 'completed' },
        ],
      },
      commands: [
        {
          cmdId: 'c1',
          before: undefined,
          after: {
            status: 'completed',
            distribution_id: DIST_ID,
            auditCorrelationId: 'corr-d-success',
          },
        },
      ],
      machineId: MACHINE_A,
    });
    expect(verdict.kind).toBe('apply');
    if (verdict.kind === 'apply') {
      expect(verdict.status).toBe('completed');
      expect(verdict.becameTerminal).toBe(true);
      expect(verdict.targets[0].progress).toBeUndefined();
      expect(verdict.targets[0].lastProcessedCommandCorrelationId).toBe(
        'corr-d-success',
      );
    }
  });
});

describe('groupByDeploymentId / groupByDistributionId', () => {
  it('drops entries without the routing id', () => {
    const groups = groupByDeploymentId([
      { cmdId: 'c1', before: undefined, after: { status: 'completed', deployment_id: 'd1' } },
      { cmdId: 'c2', before: undefined, after: { status: 'completed' } },
    ]);
    expect(groups.size).toBe(1);
    expect(groups.get('d1')).toHaveLength(1);
  });

  it('buckets multiple commands per parent id', () => {
    const groups = groupByDistributionId([
      { cmdId: 'c1', before: undefined, after: { status: 'extracting', distribution_id: 'dist-1' } },
      { cmdId: 'c2', before: undefined, after: { status: 'completed', distribution_id: 'dist-1' } },
      { cmdId: 'c3', before: undefined, after: { status: 'completed', distribution_id: 'dist-2' } },
    ]);
    expect(groups.get('dist-1')).toHaveLength(2);
    expect(groups.get('dist-2')).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Handler: reconcileDeploymentStatus                                        */
/* ========================================================================== */

describe('reconcileDeploymentStatus handler', () => {
  it('all-success transition: marks deployment completed + writes audit', async () => {
    seedDeployment([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'completed' },
    ]);

    await reconcileDeploymentHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-success' } },
        { c1: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-success' } },
      ),
    );

    expect(deploymentUpdates()).toHaveLength(1);
    const update = deploymentUpdates()[0].payload;
    expect(update.status).toBe('completed');
    expect(update.completedAt).toBe(SERVER_TIMESTAMP_SENTINEL);
    expect(update.auditCorrelationId).toBe('corr-success');
    expect((update.targets as Array<Record<string, unknown>>)[0]).toMatchObject({
      machineId: MACHINE_A,
      status: 'completed',
      lastProcessedCommandCorrelationId: 'corr-success',
    });

    const audits = auditCallsForSite();
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      correlationId: 'corr-success',
      actor: { type: 'system', name: 'deployment_reconciler' },
      capability: 'DEPLOYMENT_MANAGE',
      target: { kind: 'deployment', id: DEPLOY_ID, machineId: MACHINE_A },
      outcome: 'allow',
    });
  });

  it('partial-failure transition: marks deployment partial', async () => {
    seedDeployment([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'completed' },
    ]);

    await reconcileDeploymentHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-fail' } },
        { c1: { status: 'failed', error: 'install error', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-fail' } },
      ),
    );

    expect(deploymentUpdates()).toHaveLength(1);
    const update = deploymentUpdates()[0].payload;
    expect(update.status).toBe('partial');
    expect(update.completedAt).toBe(SERVER_TIMESTAMP_SENTINEL);
    const target = (update.targets as Array<Record<string, unknown>>).find(
      (t) => t.machineId === MACHINE_A,
    );
    expect(target).toMatchObject({ status: 'failed', error: 'install error' });
  });

  it('all-failure transition: marks deployment failed', async () => {
    seedDeployment([
      { machineId: MACHINE_A, status: 'failed' },
      { machineId: MACHINE_B, status: 'pending' },
    ]);

    await reconcileDeploymentHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-allfail' } },
        { c1: { status: 'failed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-allfail' } },
        MACHINE_B,
      ),
    );

    expect(deploymentUpdates()).toHaveLength(1);
    expect(deploymentUpdates()[0].payload.status).toBe('failed');
  });

  it('in-progress transition: writes target update without becameTerminal', async () => {
    seedDeployment([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'pending' },
    ]);

    await reconcileDeploymentHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-prog' } },
        { c1: { status: 'downloading', progress: 42, deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-prog' } },
      ),
    );

    expect(deploymentUpdates()).toHaveLength(1);
    const update = deploymentUpdates()[0].payload;
    expect(update.status).toBe('in_progress');
    expect(update.completedAt).toBeUndefined();
    const target = (update.targets as Array<Record<string, unknown>>)[0];
    expect(target).toMatchObject({ status: 'downloading', progress: 42 });
  });

  it('cancellation: cancellation of last pending → cancelled overall', async () => {
    seedDeployment([{ machineId: MACHINE_A, status: 'pending' }]);

    await reconcileDeploymentHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-cancel' } },
        { c1: { status: 'cancelled', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-cancel' } },
      ),
    );

    expect(deploymentUpdates()).toHaveLength(1);
    expect(deploymentUpdates()[0].payload.status).toBe('cancelled');
  });

  it('idempotency: replaying the same event twice writes once', async () => {
    seedDeployment([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'pending' },
    ]);

    const event = mkEvent(
      { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-idem' } },
      { c1: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-idem' } },
    );

    await reconcileDeploymentHandler(event);
    expect(deploymentUpdates()).toHaveLength(1);
    expect(auditCallsForSite()).toHaveLength(1);

    // Second invocation — fixture already reflects the prior write
    // (lastProcessedCommandCorrelationId stamped on the target). The
    // reconcile() pure function returns `skip: already_processed`,
    // so no second write and no second audit.
    await reconcileDeploymentHandler(event);
    expect(deploymentUpdates()).toHaveLength(1);
    expect(auditCallsForSite()).toHaveLength(1);
  });

  it('skips when deployment doc does not exist', async () => {
    // No seedDeployment — the fixture is empty.
    await reconcileDeploymentHandler(
      mkEvent(
        {},
        { c1: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-orphan' } },
      ),
    );
    expect(deploymentUpdates()).toHaveLength(0);
    expect(auditCallsForSite()).toHaveLength(0);
  });

  it('writes error audit row when parent update fails', async () => {
    seedDeployment([{ machineId: MACHINE_A, status: 'pending' }]);
    updateShouldReject = new Error('firestore unavailable');

    await expect(
      reconcileDeploymentHandler(
        mkEvent(
          { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-err' } },
          { c1: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-err' } },
        ),
      ),
    ).rejects.toThrow('firestore unavailable');

    const audits = auditCallsForSite();
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      outcome: 'error',
      errorCode: 'parent_write_failed',
      actor: { type: 'system', name: 'deployment_reconciler' },
    });
  });
});

/* ========================================================================== */
/*  Handler: reconcileDistributionStatus                                      */
/* ========================================================================== */

describe('reconcileDistributionStatus handler', () => {
  it('all-success: marks distribution completed', async () => {
    seedDistribution([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'completed' },
    ]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-1' } },
        { c1: { status: 'completed', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-1' } },
      ),
    );

    expect(distributionUpdates()).toHaveLength(1);
    const update = distributionUpdates()[0].payload;
    expect(update.status).toBe('completed');
    expect(update.completedAt).toBe(SERVER_TIMESTAMP_SENTINEL);

    const audits = auditCallsForSite();
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      actor: { type: 'system', name: 'distribution_reconciler' },
      capability: 'DISTRIBUTION_MANAGE',
      target: { kind: 'distribution', id: DIST_ID, machineId: MACHINE_A },
    });
  });

  it('partial-failure: marks distribution partial', async () => {
    seedDistribution([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'completed' },
    ]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-fail' } },
        { c1: { status: 'failed', error: 'extract error', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-fail' } },
      ),
    );

    expect(distributionUpdates()).toHaveLength(1);
    expect(distributionUpdates()[0].payload.status).toBe('partial');
  });

  it('intermediate state: writes target progress without completedAt', async () => {
    seedDistribution([{ machineId: MACHINE_A, status: 'pending' }]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-prog' } },
        { c1: { status: 'extracting', progress: 75, distribution_id: DIST_ID, auditCorrelationId: 'corr-d-prog' } },
      ),
    );

    const update = distributionUpdates()[0].payload;
    expect(update.status).toBe('in_progress');
    expect(update.completedAt).toBeUndefined();
    const target = (update.targets as Array<Record<string, unknown>>)[0];
    expect(target).toMatchObject({ status: 'extracting', progress: 75 });
  });

  it('idempotency: replay same event → no second write or audit', async () => {
    seedDistribution([
      { machineId: MACHINE_A, status: 'pending' },
      { machineId: MACHINE_B, status: 'pending' },
    ]);

    const event = mkEvent(
      { c1: { status: 'pending', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-idem' } },
      { c1: { status: 'completed', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-idem' } },
    );

    await reconcileDistributionHandler(event);
    await reconcileDistributionHandler(event);

    expect(distributionUpdates()).toHaveLength(1);
    expect(auditCallsForSite()).toHaveLength(1);
  });

  it('cancellation: marks remaining target cancelled and recomputes', async () => {
    seedDistribution([
      { machineId: MACHINE_A, status: 'completed' },
      { machineId: MACHINE_B, status: 'pending' },
    ]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-cancel' } },
        { c1: { status: 'cancelled', distribution_id: DIST_ID, auditCorrelationId: 'corr-d-cancel' } },
        MACHINE_B,
      ),
    );

    expect(distributionUpdates()).toHaveLength(1);
    // [completed, cancelled] survivors → completed by the
    // cancellation-doesn't-poison rule.
    expect(distributionUpdates()[0].payload.status).toBe('completed');
  });

  it('ignores commands without distribution_id', async () => {
    seedDistribution([{ machineId: MACHINE_A, status: 'pending' }]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', auditCorrelationId: 'corr-x' } },
        { c1: { status: 'completed', auditCorrelationId: 'corr-x' } },
      ),
    );

    expect(distributionUpdates()).toHaveLength(0);
    expect(auditCallsForSite()).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  Cross-handler invariants                                                  */
/* ========================================================================== */

describe('reconcilers — cross-cutting', () => {
  it('a deployment command does not trigger distribution writes', async () => {
    seedDeployment([{ machineId: MACHINE_A, status: 'pending' }]);
    seedDistribution([{ machineId: MACHINE_A, status: 'pending' }]);

    await reconcileDistributionHandler(
      mkEvent(
        { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-cross' } },
        { c1: { status: 'completed', deployment_id: DEPLOY_ID, type: 'install_software', auditCorrelationId: 'corr-cross' } },
      ),
    );

    // Distribution handler routes by distribution_id only — should be a no-op.
    expect(distributionUpdates()).toHaveLength(0);
  });

  it('handler is a no-op when before/after maps are identical', async () => {
    seedDeployment([{ machineId: MACHINE_A, status: 'pending' }]);

    const same = { c1: { status: 'pending', deployment_id: DEPLOY_ID, type: 'install_software' } };
    await reconcileDeploymentHandler(mkEvent(same, same));
    expect(deploymentUpdates()).toHaveLength(0);
  });
});
