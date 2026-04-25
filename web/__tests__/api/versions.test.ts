/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// Track shared state across mock-tx invocations so we can simulate two
// sequential publishes against the same roost without a real Firestore.
const txState = {
  versionCounter: 0,
  currentVersionId: null as string | null,
  previousVersionId: null as string | null,
  /** Captured `tx.set(versionRef, ...)` payloads, in call order. */
  versionWrites: [] as Array<Record<string, unknown>>,
  /** Captured `tx.set(roostRef, ...)` payloads, in call order. */
  roostWrites: [] as Array<Record<string, unknown>>,
};

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    let nthSetCall = 0;
    const tx = {
      get: async () =>
        docSnapshot('rst_test', {
          versionCounter: txState.versionCounter,
          currentVersionId: txState.currentVersionId,
          previousVersionId: txState.previousVersionId,
          name: 'lobby roost',
          targets: [],
        }),
      set: jest.fn((_ref: unknown, payload: Record<string, unknown>) => {
        // The route writes to versions sub-collection FIRST, then roost doc.
        if (nthSetCall === 0) txState.versionWrites.push(payload);
        else txState.roostWrites.push(payload);
        nthSetCall++;
      }),
      update: jest.fn(),
    };
    const result = await cb(tx);
    return result;
  },
);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    const base = mockDbFactory() as Record<string, unknown>;
    return { ...base, runTransaction: mockRunTransaction };
  },
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

// Stub R2 helpers so `verifyChunksPresent` always reports all chunks present
// + signed-url helpers don't try to talk to a real bucket.
jest.mock('@/lib/r2Client.server', () => ({
  hasChunk: jest.fn().mockResolvedValue(true),
  bucketFor: jest.fn(() => 'test-bucket'),
  currentEnv: jest.fn(() => 'test'),
  versionKey: jest.fn((roostId: string, vid: string) => `project-manifests/${roostId}/${vid}`),
  putVersionBody: jest.fn().mockResolvedValue(undefined),
  presignGetVersion: jest.fn().mockResolvedValue('https://r2.test/version-url'),
  getVersionBody: jest.fn().mockResolvedValue({ ok: false }),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { POST as createPOST } from '@/app/api/roosts/[roostId]/versions/route';
import { PATCH as patchVersion } from '@/app/api/roosts/[roostId]/versions/[versionRef]/route';

const SITE = 'site-alpha';
const ROOST = 'rst_test_0000000001';
const CHUNK_HASH = 'a'.repeat(64);

function buildVersionEnvelope(): Record<string, unknown> {
  // Minimal valid OCI-shaped version body. The route validates schemaVersion
  // + mediaType + config object + non-empty files[] with hash (64-char
  // lowercase hex) + positive size on every chunk.
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {},
    files: [
      {
        path: 'main.toe',
        size: 4,
        chunks: [{ hash: CHUNK_HASH, size: 4 }],
      },
    ],
  };
}

function authed() {
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
}

beforeEach(() => {
  jest.clearAllMocks();
  authed();
  txState.versionCounter = 0;
  txState.currentVersionId = null;
  txState.previousVersionId = null;
  txState.versionWrites.length = 0;
  txState.roostWrites.length = 0;
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
});

/* ========================================================================== */
/*  POST /api/roosts/{id}/versions — monotonic versionNumber                  */
/* ========================================================================== */

describe('POST /versions — version-number monotonicity', () => {
  async function publish(): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope() },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('first publish lands as versionNumber=1 with versionCounter=1 on roost', async () => {
    const res = await publish();
    expect(res.status).toBe(201);
    expect(res.body.versionNumber).toBe(1);
    expect(txState.versionWrites[0]!.versionNumber).toBe(1);
    expect(txState.roostWrites[0]!.versionCounter).toBe(1);
    expect(txState.roostWrites[0]!.currentVersionNumber).toBe(1);
  });

  it('two sequential publishes yield monotonic 1 → 2 (no collision, no gap)', async () => {
    const r1 = await publish();
    expect(r1.body.versionNumber).toBe(1);

    // Simulate the post-tx state for the next publish.
    txState.versionCounter = 1;
    txState.previousVersionId = txState.currentVersionId;
    txState.currentVersionId = String(r1.body.versionId);

    const r2 = await publish();
    expect(r2.body.versionNumber).toBe(2);
    expect(txState.versionWrites[1]!.versionNumber).toBe(2);
    expect(txState.roostWrites[1]!.versionCounter).toBe(2);
  });

  it('three publishes in a row stay monotonic 1, 2, 3', async () => {
    for (const n of [1, 2, 3]) {
      const r = await publish();
      expect(r.body.versionNumber).toBe(n);
      txState.versionCounter = n;
      txState.previousVersionId = txState.currentVersionId;
      txState.currentVersionId = String(r.body.versionId);
    }
    expect(txState.versionWrites.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
    expect(txState.roostWrites.map((v) => v.versionCounter)).toEqual([1, 2, 3]);
  });

  it('the version doc + roost doc are written in the SAME transaction', async () => {
    // The route runs `tx.set(versionRef, ...)` then `tx.set(roostRef, ...)`
    // inside the SAME runTransaction callback. A single mockRunTransaction
    // call should record both writes.
    await publish();
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(txState.versionWrites).toHaveLength(1);
    expect(txState.roostWrites).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  POST /versions — description round-trip + 500-char cap                    */
/* ========================================================================== */

describe('POST /versions — description field', () => {
  async function publishWith(description: unknown): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope(), description },
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('description round-trips: provided string lands on the version doc', async () => {
    const desc = 'fixed broken lobby video';
    const res = await publishWith(desc);
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBe(desc);
    expect(txState.roostWrites[0]!.currentVersionDescription).toBe(desc);
  });

  it('description omitted → stored as null on version doc', async () => {
    const req = createMockRequest(`http://localhost/api/roosts/${ROOST}/versions`, {
      method: 'POST',
      body: { siteId: SITE, version: buildVersionEnvelope() }, // no description field
    });
    const res = await createPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBeNull();
  });

  it('description as whitespace-only → stored as null (normalised)', async () => {
    const res = await publishWith('   \n\t  ');
    expect(res.status).toBe(201);
    expect(txState.versionWrites[0]!.description).toBeNull();
  });

  it('description over 500 chars → 400 validation error, no transaction runs', async () => {
    const tooLong = 'x'.repeat(501);
    const res = await publishWith(tooLong);
    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('description exactly 500 chars → accepted', async () => {
    const exact = 'y'.repeat(500);
    const res = await publishWith(exact);
    expect(res.status).toBe(201);
    expect((txState.versionWrites[0]!.description as string).length).toBe(500);
  });

  it('description as a non-string → 400 validation error', async () => {
    const res = await publishWith({ not: 'a string' });
    expect(res.status).toBe(400);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  PATCH /versions/{ref} — description edit + immutability guard             */
/* ========================================================================== */

describe('PATCH /versions/{ref} — description edit', () => {
  async function patch(body: Record<string, unknown>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/versions/vrs_target_001`,
      { method: 'PATCH', body },
    );
    const res = await patchVersion(req, {
      params: Promise.resolve({ roostId: ROOST, versionRef: 'vrs_target_001' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('updates description; non-description fields rejected with version_content_immutable', async () => {
    const res = await patch({ siteId: SITE, files: [{ path: 'malicious.toe' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_content_immutable');
  });

  it('rejects PATCH with no description field (description is required)', async () => {
    const res = await patch({ siteId: SITE });
    expect(res.status).toBe(400);
  });

  it('description over 500 chars → 400, no firestore write', async () => {
    const res = await patch({ siteId: SITE, description: 'z'.repeat(501) });
    expect(res.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('PATCH with sibling field like manifestId (the old name) is rejected', async () => {
    // Defensive: an SDK or curl using the pre-rename field name should be
    // told the field is immutable, not silently accepted.
    const res = await patch({ siteId: SITE, manifestId: 'old_name' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('version_content_immutable');
  });
});
