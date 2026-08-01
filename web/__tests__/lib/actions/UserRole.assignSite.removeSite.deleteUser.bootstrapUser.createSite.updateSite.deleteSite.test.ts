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
    debug: jest.fn(),
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
import { TRIAL_LENGTH_DAYS } from '@/lib/types/customer';
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

/**
 * FakeDb whose `customers` collection is unreachable — stands in for a
 * Firestore outage on the billing write path (billing-system wave 0.1).
 */
class CustomersFailingDb extends FakeDb {
  collection(path: string): FakeCollection {
    if (path === 'customers') {
      throw new Error('simulated firestore outage on customers');
    }
    return super.collection(path);
  }
}

interface FakeQuerySnapshot {
  docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  empty: boolean;
}

/**
 * Minimal collection/query fake. `where` supports equality only and `limit`
 * truncates — enough for `createSite`'s `sites where owner == uid` existence
 * check (billing-system wave 2.7) without pulling in a Firestore emulator.
 */
class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly max: number | null = null,
  ) {}

  doc(id: string): FakeDoc {
    return new FakeDoc(this.db, `${this.path}/${id}`, id);
  }

  where(field: string, op: string, value: unknown): FakeCollection {
    if (op !== '==') throw new Error(`FakeCollection.where: unsupported operator ${op}`);
    return new FakeCollection(this.db, this.path, [...this.filters, [field, value]], this.max);
  }

  limit(n: number): FakeCollection {
    return new FakeCollection(this.db, this.path, this.filters, n);
  }

  async get(): Promise<FakeQuerySnapshot> {
    const prefix = `${this.path}/`;
    let docs = [...this.db.docs.entries()]
      .filter(([path, data]) => data !== null && path.startsWith(prefix))
      .filter(([path]) => !path.slice(prefix.length).includes('/'))
      .filter(([, data]) =>
        this.filters.every(([field, value]) => (data as Record<string, unknown>)[field] === value),
      )
      .map(([path, data]) => ({
        id: path.slice(prefix.length),
        data: () => ({ ...(data as Record<string, unknown>) }),
      }));
    if (this.max !== null) docs = docs.slice(0, this.max);
    return { docs, empty: docs.length === 0 };
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

  // billing-system wave 0.1 + the go-live gate (2026-08-01): bootstrap is
  // the one server-mediated point where an account comes into existence.
  // The clock starts only once config/billing.goLiveAt has passed — before
  // that, new accounts get the same null sentinel as backfilled ones, so a
  // pre-go-live signup can never resolve `expired` while checkout is
  // unavailable. 5.3's stamp starts everyone together.
  it('mints the null trial sentinel while billing has not gone live', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    const customer = db.docs.get('customers/uid-1') as Record<string, unknown>;
    expect(customer).toEqual({
      stripeCustomerId: null,
      subscriptionId: null,
      subscriptionStatus: null,
      subscriptionTier: null,
      trialEndsAt: null,
      billingState: 'trialing',
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      taxId: null,
    });
  });

  it('mints a live 14-day clock once goLiveAt has passed', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');
    db.seed('config/billing', { goLiveAt: new Date(now.getTime() - 1000) });

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    const customer = db.docs.get('customers/uid-1') as Record<string, unknown>;
    expect(customer).toMatchObject({
      trialEndsAt: new Date(now.getTime() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000),
      billingState: 'trialing',
    });
  });

  it('keeps the null sentinel when goLiveAt is still in the future', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');
    db.seed('config/billing', { goLiveAt: new Date(now.getTime() + 60_000) });

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(
      (db.docs.get('customers/uid-1') as Record<string, unknown>).trialEndsAt,
    ).toBeNull();
  });

  it('never overwrites an existing customers doc', async () => {
    // A backfilled doc carries `trialEndsAt: null` ("pre-go-live account,
    // clock starts at T0"). Clobbering it with now+14d would silently
    // hand an existing account a second trial.
    const db = new FakeDb();
    db.seed('customers/uid-1', { trialEndsAt: null, billingState: 'trialing' });

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(db.docs.get('customers/uid-1')).toEqual({
      trialEndsAt: null,
      billingState: 'trialing',
    });
  });

  it('does not touch the customers doc when the user already exists', async () => {
    const db = new FakeDb();
    db.seed('users/uid-1', { createdAt: 456, role: 'member' });

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
    });

    expect(db.docs.has('customers/uid-1')).toBe(false);
  });

  it('still creates the user when the customers write fails', async () => {
    // Billing bookkeeping must never fail a signup — the retry would
    // short-circuit on `already_exists` and never repair the doc anyway.
    // `scripts/backfill-customers.mjs` is the repair path.
    const db = new CustomersFailingDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'user@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    expect(db.docs.get('users/uid-1')).toMatchObject({ email: 'user@example.com' });
    expect(db.docs.has('customers/uid-1')).toBe(false);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('sanitises a spam display name before persisting', async () => {
    const db = new FakeDb();
    const now = new Date('2026-01-02T03:04:05.000Z');

    const result = await bootstrapUser(ctx, {
      uid: 'uid-spam',
      email: 'salavat@example.com',
      displayName: '15K lira bonus kapıda! https://bit.ly/trclicko 🔥 Go',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    const stored = db.docs.get('users/uid-spam') as { displayName: string };
    expect(stored.displayName).toBe('15K lira bonus kapıda! 🔥 Go');
    expect(stored.displayName).not.toContain('bit.ly');
    expect(stored.displayName).not.toMatch(/https?:/i);
  });
});

describe('site CRUD actions', () => {
  const CREATE_NOW = new Date('2026-02-03T04:05:06.000Z');

  /** Run createSite against `db` with the fixed clock and stable inputs. */
  function runCreateSite(db: FakeDb, siteId = 'site-a') {
    return createSite(ctx, {
      siteId,
      name: '  Main Gallery  ',
      ownerUid: 'owner-1',
      timezone: 'Not/AZone',
      db: db.asFirestore(),
      now: () => CREATE_NOW,
    });
  }

  it('createSite writes only the top-level site document', async () => {
    const db = new FakeDb();
    db.seed('users/owner-1', { sites: [] });

    const result = await runCreateSite(db);

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
      // Never upgraded into its tier — it was minted at it (wave 0.3).
      tierUpgradedAt: null,
    });
    expect(db.docs.get('users/owner-1')?.sites).toEqual([]);
  });

  // billing-system wave 0.3: the site tier is derived from the owner's
  // billing state, not from a flat beta constant.
  describe('createSite tier derivation', () => {
    it('mints pro for a trialing owner (the trial runs at pro level)', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: null,
        subscriptionTier: null,
        trialEndsAt: new Date(CREATE_NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
      expect(db.docs.get('sites/site-a')).toMatchObject({ tier: 'pro' });
    });

    it('mints core for an owner subscribed on the core tier', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: 'active',
        subscriptionTier: 'core',
        trialEndsAt: new Date(CREATE_NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'core' });
      expect(db.docs.get('sites/site-a')).toMatchObject({ tier: 'core' });
    });

    it('falls back to pro for a subscriber with no subscriptionTier yet', async () => {
      // Pre-go-live posture: a subscription exists but wave 2.1's webhook
      // hasn't stamped the paid tier. Don't degrade a paying account.
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: 'active',
        trialEndsAt: null,
      });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
    });

    it('mints pro when the owner has no customers doc (pre-T0 account)', async () => {
      // The backfill hasn't reached this account; resolveBillingState reads
      // an absent doc as `trialing`.
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
      expect(db.docs.get('sites/site-a')).toMatchObject({ tier: 'pro' });
    });

    it('still mints pro for an expired account — creation is gated elsewhere', async () => {
      // Deliberate until tasks 0.5/0.6 add the `requireActiveBilling` route
      // gate and 2.1 stamps paid tiers. If this flips to 'core', that change
      // must be intentional — see `deriveSiteTier`.
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: null,
        subscriptionTier: null,
        trialEndsAt: new Date(CREATE_NOW.getTime() - 1),
      });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
    });
  });

  // billing-system wave 2.7: core includes exactly one site. Enforced here
  // rather than in marketing copy alone. Route renders `core_site_limit` as
  // `403 tier_insufficient`.
  describe('createSite core one-site limit', () => {
    /** An active core subscriber. */
    function seedCoreSubscriber(db: FakeDb) {
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: 'active',
        subscriptionTier: 'core',
        trialEndsAt: new Date(CREATE_NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      });
    }

    it('blocks a core subscriber who already owns a site', async () => {
      const db = new FakeDb();
      seedCoreSubscriber(db);
      db.seed('sites/site-existing', { name: 'First', owner: 'owner-1', tier: 'core' });

      const result = await runCreateSite(db, 'site-b');

      expect(result).toEqual({ kind: 'core_site_limit' });
      // Nothing written, and no audit event for a site that was never created.
      expect(db.docs.has('sites/site-b')).toBe(false);
      expect(mockEmitMutation).not.toHaveBeenCalled();
    });

    it('allows a core subscriber their first site', async () => {
      const db = new FakeDb();
      seedCoreSubscriber(db);

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'core' });
      expect(db.docs.get('sites/site-a')).toMatchObject({ owner: 'owner-1', tier: 'core' });
    });

    it("ignores another owner's sites", async () => {
      const db = new FakeDb();
      seedCoreSubscriber(db);
      db.seed('sites/someone-else', { name: 'Theirs', owner: 'owner-2', tier: 'pro' });

      const result = await runCreateSite(db);

      expect(result).toMatchObject({ kind: 'created', tier: 'core' });
    });

    it('pro subscribers get unlimited sites', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: 'active',
        subscriptionTier: 'pro',
        trialEndsAt: new Date(CREATE_NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      });
      db.seed('sites/site-1', { name: 'One', owner: 'owner-1', tier: 'pro' });
      db.seed('sites/site-2', { name: 'Two', owner: 'owner-1', tier: 'pro' });

      const result = await runCreateSite(db, 'site-3');

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
    });

    it('trialing accounts get unlimited sites — the trial runs at pro level', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: null,
        subscriptionTier: null,
        trialEndsAt: new Date(CREATE_NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
      });
      db.seed('sites/site-1', { name: 'One', owner: 'owner-1', tier: 'pro' });

      const result = await runCreateSite(db, 'site-2');

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
    });

    it('a subscriber with no subscriptionTier stamped yet is not limited', async () => {
      // Reads as pro (see `deriveSiteTier`); an unstamped paid account must
      // never be degraded into core's limit by a missing webhook write.
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', { subscriptionStatus: 'active', trialEndsAt: null });
      db.seed('sites/site-1', { name: 'One', owner: 'owner-1' });

      const result = await runCreateSite(db, 'site-2');

      expect(result).toMatchObject({ kind: 'created', tier: 'pro' });
    });

    it('an expired core account is not answered with the tier error', async () => {
      // Lockout is the route's gate and the honest remedy is "reactivate",
      // not "upgrade" — so this path must stay out of `core_site_limit`.
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: null,
        subscriptionTier: 'core',
        trialEndsAt: new Date(CREATE_NOW.getTime() - 1),
      });
      db.seed('sites/site-1', { name: 'One', owner: 'owner-1', tier: 'core' });

      const result = await runCreateSite(db, 'site-2');

      expect(result).toMatchObject({ kind: 'created' });
    });

    it('a canceled core account is not answered with the tier error either', async () => {
      const db = new FakeDb();
      db.seed('users/owner-1', { sites: [] });
      db.seed('customers/owner-1', {
        subscriptionStatus: 'canceled',
        subscriptionTier: 'core',
        trialEndsAt: null,
      });
      db.seed('sites/site-1', { name: 'One', owner: 'owner-1', tier: 'core' });

      const result = await runCreateSite(db, 'site-2');

      expect(result).toMatchObject({ kind: 'created' });
    });

    it('a colliding site id still reports the collision, not the tier limit', async () => {
      const db = new FakeDb();
      seedCoreSubscriber(db);
      db.seed('sites/site-a', { name: 'Taken', owner: 'owner-1', tier: 'core' });

      const result = await runCreateSite(db, 'site-a');

      expect(result).toEqual({ kind: 'already_exists' });
    });
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
