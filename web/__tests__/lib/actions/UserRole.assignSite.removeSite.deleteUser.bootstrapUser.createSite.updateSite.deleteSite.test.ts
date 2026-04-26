/** @jest-environment node */

const mockEmitMutation = jest.fn();
const mockDeleteCascade = jest.fn();

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/userDeleteCascade.server', () => ({
  performUserDeleteCascade: (...args: unknown[]) => mockDeleteCascade(...args),
  cancelUserCommandsOnSites: jest.fn(async () => 0),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
  },
}));

import type { Firestore } from 'firebase-admin/firestore';
import { setUserRole } from '@/lib/actions/setUserRole.server';
import { assignSiteToUser } from '@/lib/actions/assignSiteToUser.server';
import { removeSiteFromUser } from '@/lib/actions/removeSiteFromUser.server';
import { deleteUser } from '@/lib/actions/deleteUser.server';
import { bootstrapUser } from '@/lib/actions/bootstrapUser.server';
import { createSite } from '@/lib/actions/createSite.server';
import { updateSite } from '@/lib/actions/updateSite.server';
import { deleteSite } from '@/lib/actions/deleteSite.server';

type StoredDoc = Record<string, unknown> | null;

class FakeDb {
  readonly docs = new Map<string, StoredDoc>();

  collection(path: string): FakeCollection {
    return new FakeCollection(this, path);
  }

  async runTransaction<T>(
    callback: (tx: {
      get: (ref: FakeDoc | FakeCollection) => Promise<unknown>;
      update: (ref: FakeDoc, patch: Record<string, unknown>) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return callback({
      get: (ref) => ref.get(),
      update: (ref, patch) => ref.update(patch),
    });
  }

  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { ...data });
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
  ) {}

  doc(id: string): FakeDoc {
    return new FakeDoc(this.db, `${this.path}/${id}`, id);
  }

  async get(): Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }> {
    const prefix = `${this.path}/`;
    const docs = [...this.db.docs.entries()]
      .filter(([path, data]) => data !== null && path.startsWith(prefix))
      .filter(([path]) => !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => ({
        id: path.slice(prefix.length),
        data: () => ({ ...(data as Record<string, unknown>) }),
      }));
    return { docs };
  }
}

class FakeDoc {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    readonly id: string,
  ) {}

  async get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }> {
    const data = this.db.docs.get(this.path);
    return {
      exists: data !== undefined && data !== null,
      data: () => (data ? { ...data } : undefined),
    };
  }

  async set(data: Record<string, unknown>): Promise<void> {
    this.db.docs.set(this.path, { ...data });
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    const current = this.db.docs.get(this.path);
    const next = current && current !== null ? { ...current } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isFieldOp(value, 'arrayUnion')) {
        const currentArray = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        for (const item of value.items) {
          if (!currentArray.includes(item)) currentArray.push(item);
        }
        next[key] = currentArray;
      } else if (isFieldOp(value, 'arrayRemove')) {
        const currentArray = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        next[key] = currentArray.filter((item) => !value.items.includes(item));
      } else {
        next[key] = value;
      }
    }
    this.db.docs.set(this.path, next);
  }

  async delete(): Promise<void> {
    this.db.docs.set(this.path, null);
  }
}

function isFieldOp(
  value: unknown,
  op: 'arrayUnion' | 'arrayRemove',
): value is { __op: string; items: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __op?: unknown }).__op === op &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

const ctx = {
  auditActor: 'user:admin',
  endpoint: '/test',
  method: 'POST',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setUserRole', () => {
  it('updates a role and emits role-change audit metadata', async () => {
    const db = new FakeDb();
    db.seed('users/admin', { role: 'superadmin' });
    db.seed('users/alice', { role: 'member' });

    const result = await setUserRole(ctx, {
      uid: 'alice',
      role: 'admin',
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      previousRole: 'member',
      newRole: 'admin',
    });
    expect(db.docs.get('users/alice')?.role).toBe('admin');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({ from: 'member', to: 'admin' }),
      }),
    );
  });

  it('blocks demotion of the last active superadmin', async () => {
    const db = new FakeDb();
    db.seed('users/admin', { role: 'superadmin' });

    const result = await setUserRole(ctx, {
      uid: 'admin',
      role: 'member',
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'last_superadmin', activeSuperadmins: 1 });
    expect(db.docs.get('users/admin')?.role).toBe('superadmin');
  });
});

describe('assignSiteToUser', () => {
  it('adds site ids via arrayUnion after validating user and sites', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: ['site-a'] });
    db.seed('sites/site-a', { name: 'a' });
    db.seed('sites/site-b', { name: 'b' });

    const result = await assignSiteToUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-b'],
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      assignedSiteIds: ['site-a', 'site-b'],
    });
    expect(db.docs.get('users/alice')?.sites).toEqual(['site-a', 'site-b']);
  });

  it('rejects unknown sites without mutating membership', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: [] });
    db.seed('sites/site-a', { name: 'a' });

    const result = await assignSiteToUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-z'],
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'unknown_sites', unknownSites: ['site-z'] });
    expect(db.docs.get('users/alice')?.sites).toEqual([]);
  });
});

describe('removeSiteFromUser', () => {
  it('removes site ids via arrayRemove and reports cancel sweep count', async () => {
    const db = new FakeDb();
    db.seed('users/alice', { sites: ['site-a', 'site-b', 'site-c'] });

    const result = await removeSiteFromUser(ctx, {
      uid: 'alice',
      siteIds: ['site-a', 'site-b'],
      db: db.asFirestore(),
      cancelCommands: jest.fn(async () => 2),
    });

    expect(result).toEqual({
      kind: 'updated',
      removedSiteIds: ['site-a', 'site-b'],
      cancelledCommandCount: 2,
    });
    expect(db.docs.get('users/alice')?.sites).toEqual(['site-c']);
  });
});

describe('deleteUser', () => {
  it('delegates to the user-delete cascade and audits successful deletes', async () => {
    mockDeleteCascade.mockResolvedValue({
      kind: 'deleted',
      deletedAt: 123,
      transferredSites: ['site-a'],
      revokedKeyIds: ['key-1'],
    });

    const result = await deleteUser(ctx, {
      uid: 'alice',
      successorUid: 'bob',
    });

    expect(result.kind).toBe('deleted');
    expect(mockDeleteCascade).toHaveBeenCalledWith('alice', {
      successorUid: 'bob',
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'soft_deleted' }),
      }),
    );
  });
});

describe('bootstrapUser', () => {
  it('creates the caller user doc with member defaults', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      displayName: 'User One',
      timezone: 'America/Los_Angeles',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result).toEqual({
      kind: 'created',
      uid: 'uid-1',
      email: 'user@example.com',
      displayName: 'User One',
      timezone: 'America/Los_Angeles',
      createdAt: now.getTime(),
    });
    expect(db.docs.get('users/uid-1')).toMatchObject({
      email: 'user@example.com',
      role: 'member',
      sites: [],
      mfaEnrolled: false,
      requiresMfaSetup: true,
      preferences: {
        temperatureUnit: 'C',
        timezone: 'America/Los_Angeles',
      },
    });
  });

  it('is idempotent when the user doc already exists', async () => {
    const db = new FakeDb();
    db.seed('users/uid-1', { createdAt: 456, role: 'member' });

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'already_exists', createdAt: 456 });
  });
});

describe('site CRUD actions', () => {
  it('createSite writes only the top-level site document', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: [] });
    const now = new Date('2026-02-03T04:05:06.000Z');

    const result = await createSite(ctx, {
      siteId: 'site-a',
      name: '  Main Gallery  ',
      ownerUid: 'owner-1',
      timezone: 'Not/AZone',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result).toMatchObject({
      kind: 'created',
      siteId: 'site-a',
      name: 'Main Gallery',
      owner: 'owner-1',
      timezone: 'Not/AZone',
    });
    expect(db.docs.get('sites/site-a')).toMatchObject({
      name: 'Main Gallery',
      owner: 'owner-1',
      timezone: 'Not/AZone',
    });
    expect(db.docs.get('users/owner-1')?.sites).toEqual([]);
  });

  it('updateSite writes whitelisted fields and allows arbitrary timezone strings', async () => {
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'old', timezone: 'UTC' });

    const result = await updateSite(ctx, {
      siteId: 'site-a',
      name: '  new name  ',
      timezone: 'Not/AZone',
      timeFormat: '24h',
      db: db.asFirestore(),
    });

    expect(result).toEqual({
      kind: 'updated',
      updated: {
        name: 'new name',
        timezone: 'Not/AZone',
        timeFormat: '24h',
      },
    });
    expect(db.docs.get('sites/site-a')).toMatchObject({
      name: 'new name',
      timezone: 'Not/AZone',
      timeFormat: '24h',
    });
  });

  it('deleteSite deletes only the top-level site document', async () => {
    const db = new FakeDb();
    db.seed('sites/site-a', { name: 'a' });
    db.seed('sites/site-a/machines/machine-1', { online: true });

    const result = await deleteSite(ctx, {
      siteId: 'site-a',
      db: db.asFirestore(),
    });

    expect(result).toEqual({ kind: 'deleted', siteId: 'site-a' });
    expect(db.docs.get('sites/site-a')).toBeNull();
    expect(db.docs.get('sites/site-a/machines/machine-1')).toEqual({ online: true });
  });
});
