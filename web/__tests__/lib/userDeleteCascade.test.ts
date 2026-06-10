/** @jest-environment node */

/**
 * Item 21: admin-side user delete cascade revokes Firebase Auth tokens
 * AND disables the Auth user.
 *
 * This complements the existing deleteOwnAccount.test.ts (covers the
 * self-delete path). `performUserDeleteCascade` is the superadmin path
 * triggered by `DELETE /api/users/{uid}`.
 *
 * Coverage:
 *   - happy path: revokeRefreshTokens + updateUser({disabled:true})
 *     are both invoked exactly once each
 *   - both fire even when the user has no owned sites
 *   - auth/user-not-found from updateUser → still reports authDisabled
 *     (the user is already gone, no rollback needed)
 *   - getAdminAuth() throwing entirely → cascade still completes the
 *     Firestore soft-delete (rules already gate on deletedAt)
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
      docs.set(path, { exists: false });
    },
  };
}

function makeCollectionRef(path: string): Record<string, unknown> {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: () => ({
      get: async () => {
        // The only `where` queries in the cascade are:
        //   sites.where('owner','==',uid)
        // For tests we always return an empty result (the orphan-sites
        // path is exercised by deleteOwnAccount.test.ts; here we only
        // care about the Auth-revoke side).
        return { docs: [] };
      },
    }),
    get: async () => ({ docs: [] }),
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
      passkeyEnrolled: false,
      mfaEnrolled: false,
      mfaSecret: '__FIELD_DELETE__',
      backupCodes: [],
      mfaEnrolledAt: '__FIELD_DELETE__',
      requiresMfaSetup: false,
      deletedBy: 'superadmin',
    });
    expect(softDelete?.payload.deletedAt).toEqual(expect.any(Number));
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
    // The cascade still flags authDisabled — the user has no Auth record
    // to disable, which is the same end-state.
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
    // Firestore soft-delete still happened — the deletedAt stamp is
    // what authoritatively gates dashboard reads via firestore.rules.
    expect(outcome.authDisabled).toBe(false);
    // The user doc should carry deletedAt.
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
});
