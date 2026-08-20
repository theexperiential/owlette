/** @jest-environment node */

/**
 * `POST /api/users/{uid}/mfa-reset` — the superadmin recovery path for an
 * account that has lost every second factor AND its backup codes.
 *
 * Harness style follows `__tests__/api/users/deletions/route.test.ts`: a
 * path-keyed in-memory Firestore, a mocked `resolveAuth`, and the REAL
 * `authorizedPlatformHandler` / `capabilities` / `mfaFactors.server` /
 * `deviceTrust.server` underneath — so the superadmin gate, the factor
 * recompute and the trusted-device sweep are all exercised for real rather
 * than asserted against stubs that always agree.
 *
 * The four properties worth pinning down are the four that would hurt:
 *
 *   1. A reset really empties the account: no TOTP secret, no backup codes, no
 *      passkey documents, no trusted devices — and the derived flags land as
 *      "not enrolled, setup required" so the target is put straight back into
 *      mandatory setup instead of being left open.
 *   2. A non-superadmin is refused and NOTHING is written. A route that 403s
 *      after mutating is worse than one that never existed.
 *   3. The audit trail names both parties. A silent factor reset is
 *      indistinguishable from an attacker with a superadmin session.
 *   4. Resetting a user who already holds no factors is a safe no-op, because
 *      that is the state an operator retries into after a partial failure.
 */

import { createMockRequest } from '../helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

/* -------------------------------------------------------------------------- */
/*  Auth / kill-switch / rate-limit mocks                                     */
/* -------------------------------------------------------------------------- */

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: () => ({}),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

/* -------------------------------------------------------------------------- */
/*  Firestore field sentinels                                                 */
/* -------------------------------------------------------------------------- */

const DELETE_SENTINEL = { __sentinel: 'delete' };
const SERVER_TIMESTAMP = { __sentinel: 'serverTimestamp' };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => DELETE_SENTINEL,
    serverTimestamp: () => SERVER_TIMESTAMP,
  },
}));

/* -------------------------------------------------------------------------- */
/*  Firestore mock — a flat path -> data map                                  */
/* -------------------------------------------------------------------------- */

type Data = Record<string, unknown>;

/** Every document in the fake database, keyed by full slash-joined path. */
const store = new Map<string, Data>();

/** Auto-ids for `collection(...).doc()` with no id (the audit-row writer). */
let autoIdCounter = 0;

/**
 * Apply a `set`/`update` payload, honoring the two FieldValue sentinels and
 * the `{ merge: true }` flag the inventory module writes with.
 */
function applyWrite(path: string, payload: Data, merge: boolean): void {
  const base = merge ? { ...(store.get(path) ?? {}) } : {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === DELETE_SENTINEL) {
      delete base[key];
    } else if (value === SERVER_TIMESTAMP) {
      base[key] = '__SERVER_TIMESTAMP__';
    } else {
      base[key] = value;
    }
  }
  store.set(path, base);
}

interface FakeDocRef {
  __kind: 'doc';
  id: string;
  path: string;
  collection(name: string): FakeCollectionRef;
  get(): Promise<unknown>;
  set(payload: Data, options?: { merge?: boolean }): Promise<void>;
  update(payload: Data): Promise<void>;
  delete(): Promise<void>;
}

interface FakeCollectionRef {
  __kind: 'collection';
  path: string;
  doc(id?: string): FakeDocRef;
  get(): Promise<unknown>;
}

function snapshotOf(path: string) {
  const data = store.get(path);
  return {
    exists: data !== undefined,
    id: path.split('/').pop() as string,
    data: () => data,
  };
}

/** Direct children of a collection path — one more segment, no deeper. */
function childPaths(collectionPath: string): string[] {
  const prefix = `${collectionPath}/`;
  return [...store.keys()].filter(
    (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'),
  );
}

function querySnapshotOf(collectionPath: string) {
  const paths = childPaths(collectionPath);
  return {
    size: paths.length,
    empty: paths.length === 0,
    docs: paths.map((p) => ({
      id: p.split('/').pop() as string,
      exists: true,
      data: () => store.get(p),
      ref: makeDocRef(p),
    })),
  };
}

function makeDocRef(path: string): FakeDocRef {
  return {
    __kind: 'doc',
    id: path.split('/').pop() as string,
    path,
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
    get: async () => snapshotOf(path),
    set: async (payload, options) => applyWrite(path, payload, options?.merge === true),
    update: async (payload) => applyWrite(path, payload, true),
    delete: async () => {
      store.delete(path);
    },
  };
}

function makeCollectionRef(path: string): FakeCollectionRef {
  return {
    __kind: 'collection',
    path,
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto_${++autoIdCounter}`}`),
    get: async () => querySnapshotOf(path),
  };
}

/** Ops queued on a batch; committed together the way Firestore does. */
type BatchOp = () => void;

const fakeDb = {
  collection: (name: string) => makeCollectionRef(name),
  batch: () => {
    const ops: BatchOp[] = [];
    return {
      delete: (ref: FakeDocRef) => ops.push(() => store.delete(ref.path)),
      set: (ref: FakeDocRef, payload: Data, options?: { merge?: boolean }) =>
        ops.push(() => applyWrite(ref.path, payload, options?.merge === true)),
      update: (ref: FakeDocRef, payload: Data) =>
        ops.push(() => applyWrite(ref.path, payload, true)),
      commit: async () => {
        for (const op of ops) op();
      },
    };
  },
  // Reads resolve immediately and writes land on commit of the callback, which
  // is enough for the inventory module: it performs every read before its
  // single write, so there is no read-after-write ordering to emulate.
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: BatchOp[] = [];
    const tx = {
      get: async (ref: FakeDocRef | FakeCollectionRef) =>
        ref.__kind === 'doc' ? snapshotOf(ref.path) : querySnapshotOf(ref.path),
      set: (ref: FakeDocRef, payload: Data, options?: { merge?: boolean }) =>
        pending.push(() => applyWrite(ref.path, payload, options?.merge === true)),
      update: (ref: FakeDocRef, payload: Data) =>
        pending.push(() => applyWrite(ref.path, payload, true)),
      delete: (ref: FakeDocRef) => pending.push(() => store.delete(ref.path)),
    };
    const result = await fn(tx);
    for (const op of pending) op();
    return result;
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

/* -------------------------------------------------------------------------- */
/*  Imports come AFTER mocks                                                  */
/* -------------------------------------------------------------------------- */

import { POST } from '@/app/api/users/[uid]/mfa-reset/route';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const SUPERADMIN_UID = 'user-superadmin';
const TARGET_UID = 'user-target';
const AUDIT_ENTRIES = 'global/audit_log/entries';

function seedUser(uid: string, data: Data): void {
  store.set(`users/${uid}`, data);
}

/** Authenticate as a session-backed user (no api key -> scope check bypassed). */
function authedAs(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

/**
 * A target holding both factor kinds plus a live trusted device — the account
 * shape a real reset has to dismantle.
 */
function seedFullyEnrolledTarget(): void {
  seedUser(TARGET_UID, {
    email: 'locked-out@example.com',
    role: 'member',
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: true, passkeys: 2 },
    mfaSecret: 'enc:v1:secret',
    backupCodes: ['hash-a', 'hash-b'],
    mfaEnrolledAt: 1_700_000_000_000,
    passkeyEnrolled: true,
  });
  store.set(`users/${TARGET_UID}/passkeys/cred-1`, { credentialId: 'cred-1' });
  store.set(`users/${TARGET_UID}/passkeys/cred-2`, { credentialId: 'cred-2' });
  store.set(`users/${TARGET_UID}/trustedDevices/hash-1`, {
    tokenHash: 'hash-1',
    expiresAt: Date.now() + 86_400_000,
  });
}

function reset(uid = TARGET_UID) {
  return POST(
    createMockRequest(`http://localhost/api/users/${uid}/mfa-reset`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ uid }) },
  );
}

/** The mutation audit events this route emitted, newest call last. */
function mutationEvents(): Array<Record<string, unknown>> {
  return mockEmitMutation.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  autoIdCounter = 0;
  seedUser(SUPERADMIN_UID, { role: 'superadmin', email: 'sa@example.com' });
  authedAs(SUPERADMIN_UID);
});

/* ========================================================================== */

describe('POST /api/users/{uid}/mfa-reset', () => {
  it('leaves the target with zero factors, setup re-armed, and no trusted devices', async () => {
    seedFullyEnrolledTarget();

    const res = await reset();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      uid: TARGET_UID,
      clearedTotp: true,
      deletedPasskeys: 2,
      trustedDevicesRevoked: 1,
      enrolled: false,
      setupRequired: true,
    });

    const target = store.get(`users/${TARGET_UID}`) as Data;
    // The inventory module owns these three; assert the OUTCOME, not the
    // mechanism — the route is forbidden from writing them itself.
    expect(target.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(target.mfaEnrolled).toBe(false);
    expect(target.requiresMfaSetup).toBe(true);

    // Nothing usable as a second factor may survive the reset.
    expect(target.mfaSecret).toBeUndefined();
    expect(target.mfaEnrolledAt).toBeUndefined();
    expect(target.backupCodes).toEqual([]);
    expect(target.passkeyEnrolled).toBe(false);
    expect(target.mfaResetBy).toBe(SUPERADMIN_UID);
    expect(target.mfaResetAt).toBe('__SERVER_TIMESTAMP__');

    // Credential documents and trust records are gone, not just untallied.
    expect(childPaths(`users/${TARGET_UID}/passkeys`)).toEqual([]);
    expect(childPaths(`users/${TARGET_UID}/trustedDevices`)).toEqual([]);
  });

  it('refuses a non-superadmin with 403 and writes nothing', async () => {
    seedUser('user-admin', { role: 'admin', email: 'admin@example.com' });
    authedAs('user-admin');
    seedFullyEnrolledTarget();
    const before = new Map(store);

    const res = await reset();

    expect(res.status).toBe(403);

    // Every seeded document survives byte-for-byte, and the only new rows are
    // the wrapper's deny audit — no user-doc write, no credential delete.
    const target = store.get(`users/${TARGET_UID}`) as Data;
    expect(target).toEqual(before.get(`users/${TARGET_UID}`));
    expect(childPaths(`users/${TARGET_UID}/passkeys`)).toHaveLength(2);
    expect(childPaths(`users/${TARGET_UID}/trustedDevices`)).toHaveLength(1);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('records an audit row naming the acting superadmin and the target', async () => {
    seedFullyEnrolledTarget();

    await reset();

    // The loud, human-readable row: who did it, to whom, and what was taken.
    const events = mutationEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'user_mutated',
      actor: `user:${SUPERADMIN_UID}`,
      targetId: TARGET_UID,
    });
    expect(events[0].attributes).toMatchObject({
      verb: 'mfa_force_reset',
      actorUid: SUPERADMIN_UID,
      targetUid: TARGET_UID,
      targetEmail: 'locked-out@example.com',
      clearedTotp: true,
      deletedPasskeys: 2,
      trustedDevicesRevoked: 1,
      stillEnrolled: false,
      setupReArmed: true,
    });

    // …and the capability row the platform wrapper writes, which is what an
    // auditor queries by capability rather than by verb.
    const capabilityRows = childPaths(AUDIT_ENTRIES).map(
      (p) => store.get(p) as Data,
    );
    const allow = capabilityRows.find((row) => row.outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow).toMatchObject({
      capability: 'USER_ROLE_MANAGE',
      target: { kind: 'user', id: TARGET_UID },
    });
    expect((allow!.actor as Data).userId).toBe(SUPERADMIN_UID);
  });

  it('is a safe no-op on a user who already holds no factors', async () => {
    seedUser(TARGET_UID, {
      email: 'never-enrolled@example.com',
      role: 'member',
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });

    const res = await reset();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      clearedTotp: false,
      deletedPasskeys: 0,
      trustedDevicesRevoked: 0,
      enrolled: false,
      setupRequired: true,
    });

    const target = store.get(`users/${TARGET_UID}`) as Data;
    expect(target.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(target.requiresMfaSetup).toBe(true);
    expect(target.email).toBe('never-enrolled@example.com');
  });

  it('refuses a superadmin resetting their own factors', async () => {
    // Reachable only from a live session, for which `/api/mfa/disable` (live
    // proof of possession) is the supported path — see the route header.
    const res = await reset(SUPERADMIN_UID);

    expect(res.status).toBe(403);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('404s an unknown uid without emitting a mutation', async () => {
    const res = await reset('user-nobody');

    expect(res.status).toBe(404);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted target so the delete cascade is not undone', async () => {
    // `userDeleteCascade` deliberately leaves `requiresMfaSetup` false on a
    // deleted account; running it through the inventory module would re-arm
    // the nag on someone who no longer has an account.
    seedUser(TARGET_UID, {
      email: 'gone@example.com',
      role: 'member',
      deletedAt: 1_700_000_000_000,
      mfaFactors: { totp: false, passkeys: 0 },
      requiresMfaSetup: false,
    });

    const res = await reset();

    expect(res.status).toBe(400);
    expect((store.get(`users/${TARGET_UID}`) as Data).requiresMfaSetup).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
