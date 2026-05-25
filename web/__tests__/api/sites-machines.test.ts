/** @jest-environment node */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(d: Date): MockTimestamp {
      return new MockTimestamp(d.getTime());
    }

    toDate(): Date {
      return new Date(this.ms);
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    },
    Timestamp: MockTimestamp,
  };
});

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

const docStore: Record<string, Record<string, unknown> | null> = {};
const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function syncCollection(parts: string[], docId: string, data: Record<string, unknown> | null): void {
  const colPath = pathFor(parts.slice(0, -1));
  if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
  const idx = collectionDocs[colPath].findIndex((d) => d.id === docId);
  if (data === null) {
    if (idx >= 0) collectionDocs[colPath].splice(idx, 1);
  } else if (idx >= 0) {
    collectionDocs[colPath][idx] = { id: docId, data };
  } else {
    collectionDocs[colPath].push({ id: docId, data });
  }
}

function applyPatch(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...patch };
}

function makeDocRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const docId = parts[parts.length - 1];
  const ref: Record<string, unknown> = {
    id: docId,
    path,
    get: jest.fn(async () => {
      const data = docStore[path];
      return {
        exists: data !== undefined && data !== null,
        id: docId,
        data: () => data ?? undefined,
      };
    }),
    set: jest.fn(async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      const next = options?.merge ? applyPatch(docStore[path] ?? {}, data) : data;
      docStore[path] = next;
      syncCollection(parts, docId, next);
    }),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      const next = applyPatch(docStore[path] ?? {}, patch);
      docStore[path] = next;
      syncCollection(parts, docId, next);
    }),
    delete: jest.fn(async () => {
      docStore[path] = null;
      syncCollection(parts, docId, null);
    }),
    collection: (name: string) => makeCollectionRef([...parts, name]),
  };
  return ref;
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const wheres: WhereClause[] = [];

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    get: jest.fn(async () => {
      let docs = (collectionDocs[path] || []).slice();
      for (const w of wheres) {
        docs = docs.filter((d) => {
          const fieldValue = w.field === '__name__' ? d.id : d.data[w.field];
          if (w.op === '==') return fieldValue === w.value;
          if (w.op === 'array-contains') {
            return Array.isArray(fieldValue) && fieldValue.includes(w.value);
          }
          return true;
        });
      }
      return {
        docs: docs.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
          ref: makeDocRef([...parts, d.id]),
        })),
        empty: docs.length === 0,
      };
    }),
  };
  return ref;
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      return {
        delete: (ref: { delete: () => Promise<void> }) => {
          ops.push(() => ref.delete());
        },
        commit: async () => {
          for (const op of ops) await op();
        },
      };
    },
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

import { GET as listMachinesGET } from '@/app/api/sites/[siteId]/machines/route';
import {
  DELETE as machineDELETE,
  GET as machineGET,
} from '@/app/api/sites/[siteId]/machines/[machineId]/route';
import { GET as machineDeploymentsGET } from '@/app/api/sites/[siteId]/machines/[machineId]/deployments/route';

type Scope = {
  resource: 'site' | 'machine';
  id: string;
  permissions: string[];
};

const SITE = 'site-alpha';
const MACHINE = 'mach-1';

function putDoc(path: string, data: Record<string, unknown>): void {
  const parts = path.split('/');
  docStore[path] = data;
  syncCollection(parts, parts[parts.length - 1], data);
}

function seedSite(siteId = SITE, data: Record<string, unknown> = {}): void {
  putDoc(`sites/${siteId}`, { name: siteId, owner: 'owner-uid', ...data });
}

function seedUser(uid: string, data: Record<string, unknown> = {}): void {
  putDoc(`users/${uid}`, {
    email: `${uid}@example.com`,
    role: 'superadmin',
    sites: [SITE],
    ...data,
  });
}

function seedMachine(machineId = MACHINE, data: Record<string, unknown> = {}): void {
  putDoc(`sites/${SITE}/machines/${machineId}`, {
    name: machineId,
    online: true,
    lastHeartbeat: 1_700_000_000_000,
    ...data,
  });
}

function seedRoost(roostId: string, data: Record<string, unknown>): void {
  putDoc(`sites/${SITE}/roosts/${roostId}`, data);
}

function seedTargetState(
  roostId: string,
  machineId: string,
  data: Record<string, unknown>,
): void {
  putDoc(`sites/${SITE}/roosts/${roostId}/target_state/${machineId}`, data);
}

function authedSession(uid = 'admin-uid', role = 'superadmin'): void {
  seedUser(uid, { role });
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

function authedKey(scopes: Scope[], uid = 'admin-uid', role = 'superadmin'): void {
  seedUser(uid, { role });
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  });
}

function siteScope(permission: string): Scope {
  return { resource: 'site', id: SITE, permissions: [permission] };
}

function machineScope(permission: string): Scope {
  return { resource: 'machine', id: MACHINE, permissions: [permission] };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(docStore)) delete docStore[key];
  for (const key of Object.keys(collectionDocs)) delete collectionDocs[key];
});

describe('GET /api/sites/{siteId}/machines', () => {
  it('returns live unpaginated machines with current roost summaries', async () => {
    seedSite();
    authedKey([siteScope('read')]);
    seedMachine('mach-b', { name: 'Beta' });
    seedMachine('mach-a', { name: 'Alpha' });
    seedRoost('roost-one', {
      name: 'Main Show',
      targets: ['mach-a'],
      currentVersionId: 'sha256:' + 'a'.repeat(64),
      versionCounter: 7,
    });

    const res = await listMachinesGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines`),
      { params: Promise.resolve({ siteId: SITE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toBeUndefined();
    expect(body.next_page_token).toBeUndefined();
    expect(body.machines.map((m: { id: string }) => m.id)).toEqual(['mach-a', 'mach-b']);
    expect(body.machines[0].currentRoosts).toEqual([
      {
        roostId: 'roost-one',
        name: 'Main Show',
        currentVersionId: 'sha256:' + 'a'.repeat(64),
        versionCounter: 7,
      },
    ]);
  });
});

describe('GET /api/sites/{siteId}/machines/{machineId}', () => {
  it('returns machine detail with metrics and processes', async () => {
    seedSite();
    authedKey([siteScope('read')]);
    seedMachine(MACHINE, {
      name: 'Lobby Player',
      hostname: 'lobby-host',
      metrics: { cpu: 0.4 },
      processes: [{ id: 'proc-1', name: 'Player' }],
    });

    const res = await machineGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}`),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      id: MACHINE,
      siteId: SITE,
      name: 'Lobby Player',
      hostname: 'lobby-host',
      metrics: { cpu: 0.4 },
    });
    expect(body.processes).toHaveLength(1);
  });
});

describe('GET /api/sites/{siteId}/machines/{machineId}/deployments', () => {
  it('returns current per-roost deployment state for the machine', async () => {
    seedSite();
    authedKey([siteScope('read')]);
    seedMachine();
    seedRoost('roost-one', {
      name: 'Main Show',
      targets: [MACHINE],
      currentVersionId: 'sha256:' + 'b'.repeat(64),
      previousVersionId: 'sha256:' + 'c'.repeat(64),
      versionCounter: 4,
      extractPath: 'C:/Shows/Main',
    });
    seedTargetState('roost-one', MACHINE, {
      reportedVersionId: 'sha256:' + 'b'.repeat(64),
      status: 'synced',
      reportedAt: 1_700_000_010_000,
    });

    const res = await machineDeploymentsGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/deployments`),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ siteId: SITE, machineId: MACHINE });
    expect(body.items).toBeUndefined();
    expect(body.deployments).toEqual([
      expect.objectContaining({
        roostId: 'roost-one',
        name: 'Main Show',
        reportedStatus: 'synced',
      }),
    ]);
  });
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}', () => {
  it('removes the machine, config, and command maps for a superadmin caller', async () => {
    seedSite();
    authedSession();
    seedMachine();
    putDoc(`config/${SITE}/machines/${MACHINE}`, { machineId: MACHINE });
    putDoc(`sites/${SITE}/machines/${MACHINE}/commands/pending`, { cmd_a: {} });
    putDoc(`sites/${SITE}/machines/${MACHINE}/commands/completed`, { cmd_b: {} });

    const res = await machineDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'remove-machine-1' },
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toEqual({
      machine: `sites/${SITE}/machines/${MACHINE}`,
      config: `config/${SITE}/machines/${MACHINE}`,
      pendingCommands: `sites/${SITE}/machines/${MACHINE}/commands/pending`,
      completedCommands: `sites/${SITE}/machines/${MACHINE}/commands/completed`,
    });
    expect(docStore[`sites/${SITE}/machines/${MACHINE}`]).toBeNull();
    expect(docStore[`config/${SITE}/machines/${MACHINE}`]).toBeNull();
    expect(docStore[`sites/${SITE}/machines/${MACHINE}/commands/pending`]).toBeNull();
    expect(docStore[`sites/${SITE}/machines/${MACHINE}/commands/completed`]).toBeNull();
  });

  it('requires Idempotency-Key for machine removal', async () => {
    seedSite();
    authedSession();
    seedMachine();

    const res = await machineDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
    expect(docStore[`sites/${SITE}/machines/${MACHINE}`]).not.toBeNull();
  });

  it('allows a site admin to remove a machine on their assigned site', async () => {
    seedSite();
    authedSession('site-admin', 'admin');
    seedMachine();

    const res = await machineDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'remove-machine-admin-1' },
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );

    expect(res.status).toBe(200);
    expect(docStore[`sites/${SITE}/machines/${MACHINE}`]).toBeNull();
  });

  it('rejects API keys without machine write scope', async () => {
    seedSite();
    authedKey([machineScope('read')]);
    seedMachine();

    const res = await machineDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
    expect(docStore[`sites/${SITE}/machines/${MACHINE}`]).not.toBeNull();
  });
});
