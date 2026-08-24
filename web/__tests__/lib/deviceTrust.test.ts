/** @jest-environment node */

/**
 * Tests for `lib/deviceTrust.server.ts`.
 *
 * Pure helpers (mint / hash / validate / cookie options) run unmocked, with
 * the crypto checked against node's own `crypto` for independence. The
 * Firestore helpers run against a mutable in-memory admin-SDK mock (same
 * `getAdminDb` chain pattern as `__tests__/api/mfa/disable.test.ts`), covering
 * doc shape, expiry pruning, the lastUsedAt bump, fail-closed read
 * propagation, and bulk revoke.
 */

import crypto from 'crypto';

// Mocked-SDK state, reset in beforeEach. Keyed by doc id (the token hash).
let store: Map<string, Record<string, unknown>>;
// When set, the next doc `.get()` rejects with it (propagation test).
let getError: Error | null;
// When set, a doc `.set()` rejects with it (write-failure test).
let setError: Error | null;
// When set, a `where(...).get()` rejects with it (prune-failure test).
let queryError: Error | null;

// Plain-array spies — not jest.fn()s, so reset manually.
const setCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
const deleteCalls: string[] = [];
const batchDeleteCalls: string[] = [];
let batchCreations = 0;
let batchCommits = 0;

function docSnapshot(id: string) {
  const data = store.get(id);
  return { exists: data !== undefined, data: () => data };
}

function makeDocRef(id: string) {
  return {
    id,
    ref: { id },
    get: async () => {
      if (getError) throw getError;
      return docSnapshot(id);
    },
    set: async (payload: Record<string, unknown>) => {
      if (setError) throw setError;
      setCalls.push({ id, payload });
      store.set(id, payload);
    },
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ id, payload });
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, ...payload });
    },
    delete: async () => {
      deleteCalls.push(id);
      store.delete(id);
    },
  };
}

function queryDocs() {
  return [...store.keys()].map((id) => ({
    id,
    ref: { id },
    data: () => store.get(id),
  }));
}

function makeCollectionRef() {
  return {
    doc: (id: string) => makeDocRef(id),
    where: (field: string, op: string, value: number) => ({
      get: async () => {
        if (queryError) throw queryError;
        const docs = queryDocs().filter((d) => {
          const v = (d.data() as Record<string, unknown> | undefined)?.[field];
          return op === '<' && typeof v === 'number' && v < value;
        });
        return { empty: docs.length === 0, docs, size: docs.length };
      },
    }),
    get: async () => {
      const docs = queryDocs();
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  };
}

function makeDb() {
  return {
    collection: (_name: string) => ({
      doc: (_uid: string) => ({
        collection: (_sub: string) => makeCollectionRef(),
      }),
    }),
    batch: () => {
      batchCreations += 1;
      return {
        delete: (ref: { id: string }) => {
          batchDeleteCalls.push(ref.id);
          store.delete(ref.id);
        },
        commit: async () => {
          batchCommits += 1;
        },
      };
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => makeDb(),
}));

import {
  DEVICE_TRUST_COOKIE,
  DEVICE_TRUST_DURATION_MS,
  createTrustedDevice,
  deviceTrustCookieOptions,
  findValidTrustedDevice,
  hashDeviceTrustToken,
  isTrustRecordValid,
  mintDeviceTrustToken,
  revokeAllTrustedDevices,
} from '@/lib/deviceTrust.server';

beforeEach(() => {
  store = new Map();
  getError = null;
  setError = null;
  queryError = null;
  setCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  batchDeleteCalls.length = 0;
  batchCreations = 0;
  batchCommits = 0;
});

// Fire-and-forget writes land on a microtask; flush before asserting.
const flush = () => Promise.resolve();

describe('deviceTrust — constants', () => {
  it('pins the cookie name and 30-day duration', () => {
    expect(DEVICE_TRUST_COOKIE).toBe('owlette_device_trust');
    expect(DEVICE_TRUST_DURATION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('mintDeviceTrustToken', () => {
  it('produces distinct raw/hash pairs across calls', () => {
    const a = mintDeviceTrustToken();
    const b = mintDeviceTrustToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('emits a base64url raw token (no +, /, or = characters)', () => {
    const { raw } = mintDeviceTrustToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain('+');
    expect(raw).not.toContain('/');
    expect(raw).not.toContain('=');
  });

  it('hash equals the sha256 hex of raw (verified against node crypto)', () => {
    const { raw, hash } = mintDeviceTrustToken();
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashDeviceTrustToken', () => {
  it('is deterministic for the same input', () => {
    const raw = 'some-opaque-token';
    expect(hashDeviceTrustToken(raw)).toBe(hashDeviceTrustToken(raw));
  });

  it('matches node crypto sha256 hex', () => {
    const raw = 'another-token';
    expect(hashDeviceTrustToken(raw)).toBe(
      crypto.createHash('sha256').update(raw).digest('hex')
    );
  });
});

describe('isTrustRecordValid', () => {
  const now = 1_000_000;

  it('rejects null / undefined / non-object', () => {
    expect(isTrustRecordValid(null, now)).toBe(false);
    expect(isTrustRecordValid(undefined, now)).toBe(false);
    expect(isTrustRecordValid(42, now)).toBe(false);
    expect(isTrustRecordValid('str', now)).toBe(false);
  });

  it('rejects a missing or non-number expiresAt', () => {
    expect(isTrustRecordValid({}, now)).toBe(false);
    expect(isTrustRecordValid({ expiresAt: '123' }, now)).toBe(false);
    expect(isTrustRecordValid({ expiresAt: null }, now)).toBe(false);
  });

  it('rejects an expiresAt at or before now', () => {
    expect(isTrustRecordValid({ expiresAt: now }, now)).toBe(false);
    expect(isTrustRecordValid({ expiresAt: now - 1 }, now)).toBe(false);
  });

  it('accepts a record whose expiresAt is after now', () => {
    expect(isTrustRecordValid({ expiresAt: now + 1 }, now)).toBe(true);
  });
});

describe('deviceTrustCookieOptions', () => {
  it('mirrors the session cookie posture with a 30-day maxAge in seconds', () => {
    const opts = deviceTrustCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60);
    expect(typeof opts.secure).toBe('boolean');
  });

  it('sets secure only in production', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(deviceTrustCookieOptions().secure).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(deviceTrustCookieOptions().secure).toBe(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('createTrustedDevice', () => {
  const now = 2_000_000;

  it('writes the record with the expected shape at the token-hash doc', async () => {
    await createTrustedDevice('user-1', 'hash-abc', 'Mozilla/5.0', now);

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].id).toBe('hash-abc');
    expect(setCalls[0].payload).toEqual({
      tokenHash: 'hash-abc',
      createdAt: now,
      expiresAt: now + DEVICE_TRUST_DURATION_MS,
      userAgent: 'Mozilla/5.0',
      lastUsedAt: now,
    });
  });

  it('prunes this user\'s expired records without touching the fresh one', async () => {
    store.set('stale-1', { tokenHash: 'stale-1', expiresAt: now - 1 });
    store.set('stale-2', { tokenHash: 'stale-2', expiresAt: now - 100 });
    store.set('fresh', { tokenHash: 'fresh', expiresAt: now + 100 });

    await createTrustedDevice('user-1', 'hash-new', 'UA', now);

    // Both stale records batch-deleted; fresh + newly-minted survive.
    expect(batchDeleteCalls.sort()).toEqual(['stale-1', 'stale-2']);
    expect(batchCommits).toBe(1);
    expect(store.has('fresh')).toBe(true);
    expect(store.has('hash-new')).toBe(true);
    expect(store.has('stale-1')).toBe(false);
    expect(store.has('stale-2')).toBe(false);
  });

  it('does not commit a batch when there is nothing to prune', async () => {
    await createTrustedDevice('user-1', 'hash-only', 'UA', now);
    expect(batchDeleteCalls).toHaveLength(0);
    expect(batchCommits).toBe(0);
  });

  it('still succeeds when pruning fails (best-effort prune)', async () => {
    queryError = new Error('prune query exploded');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        createTrustedDevice('user-1', 'hash-x', 'UA', now)
      ).resolves.toBeUndefined();
      // The record write still happened; the prune failure was logged, not
      // thrown.
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].id).toBe('hash-x');
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('propagates a failure of the authoritative record write', async () => {
    setError = new Error('set failed');
    await expect(
      createTrustedDevice('user-1', 'hash-y', 'UA', now)
    ).rejects.toThrow('set failed');
    expect(store.has('hash-y')).toBe(false);
  });
});

describe('findValidTrustedDevice', () => {
  const now = 3_000_000;
  const raw = 'raw-token-value';
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  it('returns false when the doc is missing', async () => {
    expect(await findValidTrustedDevice('user-1', raw, now)).toBe(false);
    expect(deleteCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns false and reaps a well-formed expired record', async () => {
    store.set(hash, { tokenHash: hash, expiresAt: now - 1 });
    const result = await findValidTrustedDevice('user-1', raw, now);
    await flush();
    expect(result).toBe(false);
    expect(deleteCalls).toEqual([hash]);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns false for a malformed record without deleting it', async () => {
    store.set(hash, { tokenHash: hash /* no expiresAt */ });
    const result = await findValidTrustedDevice('user-1', raw, now);
    await flush();
    expect(result).toBe(false);
    expect(deleteCalls).toHaveLength(0);
  });

  it('returns true and bumps lastUsedAt for a valid record', async () => {
    store.set(hash, {
      tokenHash: hash,
      expiresAt: now + 1000,
      lastUsedAt: now - 5000,
    });
    const result = await findValidTrustedDevice('user-1', raw, now);
    await flush();
    expect(result).toBe(true);
    expect(deleteCalls).toHaveLength(0);
    expect(updateCalls).toEqual([{ id: hash, payload: { lastUsedAt: now } }]);
  });

  it('propagates a Firestore error on the lookup read (fail-closed)', async () => {
    getError = new Error('firestore unavailable');
    await expect(findValidTrustedDevice('user-1', raw, now)).rejects.toThrow(
      'firestore unavailable'
    );
  });
});

describe('revokeAllTrustedDevices', () => {
  it('deletes every record and returns the count', async () => {
    store.set('d1', { tokenHash: 'd1', expiresAt: 10 });
    store.set('d2', { tokenHash: 'd2', expiresAt: 20 });
    store.set('d3', { tokenHash: 'd3', expiresAt: 30 });

    const count = await revokeAllTrustedDevices('user-1');

    expect(count).toBe(3);
    expect(batchDeleteCalls.sort()).toEqual(['d1', 'd2', 'd3']);
    expect(batchCommits).toBe(1);
    expect(store.size).toBe(0);
  });

  it('returns 0 and commits nothing when there are no records', async () => {
    const count = await revokeAllTrustedDevices('user-1');
    expect(count).toBe(0);
    expect(batchDeleteCalls).toHaveLength(0);
    expect(batchCommits).toBe(0);
  });

  it('chunks deletes into multiple batches when there are more than 100 docs', async () => {
    // 250 fits Firestore's 500-write ceiling, but the repo chunks at 100, so
    // this must split 100 + 100 + 50.
    for (let i = 0; i < 250; i += 1) {
      store.set(`d${i}`, { tokenHash: `d${i}`, expiresAt: 10 });
    }

    const count = await revokeAllTrustedDevices('user-1');

    expect(count).toBe(250);
    expect(batchCreations).toBe(3);
    expect(batchCommits).toBe(3);
    expect(batchDeleteCalls).toHaveLength(250);
    expect(store.size).toBe(0);
  });
});
