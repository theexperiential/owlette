/** @jest-environment node */

/**
 * `performUserDeleteCascade` — the superadmin path behind `DELETE /api/users/{uid}`
 * (self-delete lives in deleteOwnAccount.test.ts). Asserts revokeRefreshTokens +
 * updateUser({disabled:true}) each fire exactly once, with or without owned
 * sites; `auth/user-not-found` still reports authDisabled; and a throwing
 * getAdminAuth() still completes the Firestore soft-delete, which the rules gate
 * on via deletedAt.
 */

const mockRevokeRefreshTokens = jest.fn();
const mockUpdateUser = jest.fn();
const adminAuthFactory = jest.fn(() => ({
  revokeRefreshTokens: mockRevokeRefreshTokens,
  updateUser: mockUpdateUser,
}));

// Mutable doc store backing the mocked admin SDK.
interface DocSeed {
  exists: boolean;
  data?: Record<string, unknown>;
}
let docs: Map<string, DocSeed>;
let updateCalls: Array<{ path: string; payload: Record<string, unknown> }>;
let deletePaths: string[];

function makeDocRef(path: string): Record<string, unknown> {
  return {
    path,
    collection: (sub: string) => makeCollectionRef(`${path}/${sub}`),
    get: async () => {
      const seed = docs.get(path);
      return {
        exists: seed?.exists ?? false,
        data: () => (seed?.exists ? seed.data : undefined),
      };
    },
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
      const prev = docs.get(path);
      docs.set(path, {
        exists: true,
        data: { ...(prev?.data ?? {}), ...payload },
      });
    },
    delete: async () => {
      deletePaths.push(path);
      docs.set(path, { exists: false });
    },
  };
}

/**
 * Snapshot docs for the direct children of `path`, so the subcollection-sweep
 * assertions (passkeys / trustedDevices) need no per-collection seeding.
 */
function collectionDocs(path: string): Array<Record<string, unknown>> {
  const prefix = `${path}/`;
  const out: Array<Record<string, unknown>> = [];
  for (const [docPath, seed] of docs.entries()) {
    if (!seed.exists) continue;
    if (!docPath.startsWith(prefix)) continue;
    // Direct children only — skip nested subcollection paths.
    if (docPath.slice(prefix.length).includes('/')) continue;
    const id = docPath.slice(prefix.length);
    out.push({
      id,
      data: () => seed.data,
      ref: makeDocRef(docPath),
    });
  }
  return out;
}

function makeCollectionRef(path: string): Record<string, unknown> {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: () => ({
      get: async () => {
        // The cascade's only `where` is sites.where('owner','==',uid); always
        // empty here — orphan sites are deleteOwnAccount.test.ts's business.
        return { docs: [] };
      },
    }),
    get: async () => ({ docs: collectionDocs(path) }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => adminAuthFactory(),
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef(name),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...vals: unknown[]) => ({ __op: 'arrayUnion', vals }),
    delete: () => '__FIELD_DELETE__',
  },
}));

import { performUserDeleteCascade } from '@/lib/userDeleteCascade.server';

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  updateCalls = [];
  deletePaths = [];
  mockRevokeRefreshTokens.mockResolvedValue(undefined);
  mockUpdateUser.mockResolvedValue(undefined);
  adminAuthFactory.mockReturnValue({
    revokeRefreshTokens: mockRevokeRefreshTokens,
    updateUser: mockUpdateUser,
  });
});

describe('performUserDeleteCascade — Firebase Auth revoke side-effect', () => {
  it('revokes refresh tokens AND disables the Auth user on happy path', async () => {
    docs.set('users/uid-victim', {
      exists: true,
      data: { uid: 'uid-victim', role: 'member', sites: [] },
    });

    const outcome = await performUserDeleteCascade('uid-victim');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');

    expect(mockRevokeRefreshTokens).toHaveBeenCalledTimes(1);
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith('uid-victim');

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith('uid-victim', {
      disabled: true,
    });

    expect(outcome.authDisabled).toBe(true);
    const softDelete = updateCalls.find((call) => call.path === 'users/uid-victim');
    expect(softDelete?.payload).toMatchObject({
      sites: [],
      mfaEnrolled: false,
      // Zero the denormalized inventory too: a stale `{totp:true, passkeys:n}` is
      // well-formed enough for `normalizeMfaFactors` to trust, so the next
      // recompute would resurrect `mfaEnrolled: true` on a deleted account.
      mfaFactors: { totp: false, passkeys: 0 },
      mfaSecret: '__FIELD_DELETE__',
      backupCodes: [],
      mfaEnrolledAt: '__FIELD_DELETE__',
      // Deliberately false, not re-armed — written directly rather than via
      // `applyMfaFactorChange`, which derives `requiresMfaSetup = true` on zero
      // factors and would push a soft-deleted account into mandatory 2FA setup.
      requiresMfaSetup: false,
      deletedBy: 'superadmin',
    });
    expect(softDelete?.payload.deletedAt).toEqual(expect.any(Number));
    // toMatchObject is subset-matching, so assert the zeroed inventory exactly.
    expect(softDelete?.payload.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(softDelete?.payload.requiresMfaSetup).toBe(false);
  });

  it('treats auth/user-not-found from updateUser as already-disabled (no rollback)', async () => {
    docs.set('users/uid-gone', {
      exists: true,
      data: { uid: 'uid-gone', role: 'member', sites: [] },
    });
    const notFound = new Error('not found') as Error & { code?: string };
    notFound.code = 'auth/user-not-found';
    mockUpdateUser.mockRejectedValueOnce(notFound);

    const outcome = await performUserDeleteCascade('uid-gone');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');
    // Still flags authDisabled: no Auth record to disable is the same end state.
    expect(outcome.authDisabled).toBe(true);
  });

  it('continues even when getAdminAuth() throws (rules already gate on deletedAt)', async () => {
    docs.set('users/uid-no-auth', {
      exists: true,
      data: { uid: 'uid-no-auth', role: 'member', sites: [] },
    });
    adminAuthFactory.mockImplementationOnce(() => {
      throw new Error('admin SDK uninitialised');
    });

    const outcome = await performUserDeleteCascade('uid-no-auth');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');
    // Soft-delete still happened — deletedAt is what firestore.rules gates on.
    expect(outcome.authDisabled).toBe(false);
    const userDoc = docs.get('users/uid-no-auth');
    expect(userDoc?.data?.deletedAt).toBeDefined();
  });

  it('non-fatal: revokeRefreshTokens failure (non-not-found) does NOT block updateUser', async () => {
    docs.set('users/uid-revoke-flake', {
      exists: true,
      data: { uid: 'uid-revoke-flake', role: 'member', sites: [] },
    });
    mockRevokeRefreshTokens.mockRejectedValueOnce(new Error('transient'));

    const outcome = await performUserDeleteCascade('uid-revoke-flake');

    expect(outcome.kind).toBe('deleted');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith('uid-revoke-flake', {
      disabled: true,
    });
  });

  it('already-soft-deleted user returns already_deleted without re-revoking', async () => {
    docs.set('users/uid-soft', {
      exists: true,
      data: {
        uid: 'uid-soft',
        role: 'member',
        sites: [],
        deletedAt: 1700000000000,
      },
    });

    const outcome = await performUserDeleteCascade('uid-soft');

    expect(outcome.kind).toBe('already_deleted');
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('sweeps the trustedDevices subcollection so stale device-trust cookies die', async () => {
    docs.set('users/uid-td', {
      exists: true,
      data: { uid: 'uid-td', role: 'member', sites: [] },
    });
    // Two hashed-token device-trust records (doc id === token hash).
    docs.set('users/uid-td/trustedDevices/hash-1', {
      exists: true,
      data: { tokenHash: 'hash-1' },
    });
    docs.set('users/uid-td/trustedDevices/hash-2', {
      exists: true,
      data: { tokenHash: 'hash-2' },
    });

    const outcome = await performUserDeleteCascade('uid-td');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');

    // Both device-trust docs deleted, so a surviving cookie can't resolve to a
    // record and skip the MFA challenge.
    expect(deletePaths).toContain('users/uid-td/trustedDevices/hash-1');
    expect(deletePaths).toContain('users/uid-td/trustedDevices/hash-2');
    expect(docs.get('users/uid-td/trustedDevices/hash-1')?.exists).toBe(false);
    expect(docs.get('users/uid-td/trustedDevices/hash-2')?.exists).toBe(false);
  });
});
