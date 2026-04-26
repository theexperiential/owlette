/** @jest-environment node */

/**
 * Unit tests for `web/lib/rateLimit.server.ts` (security-boundary-migration
 * wave 1.4).
 *
 * Coverage:
 *   - in-memory token bucket: refill, cross-actor isolation, cross-bucket
 *     isolation, capability isolation, capacity edge cases
 *   - firestore sharded counter: under-limit allow, over-limit reject,
 *     window roll-over, shard distribution, retryAfter math, fail-open on
 *     transaction error
 *   - combined entry point: in-memory short-circuit, system actor cannot
 *     consume user-bucket tokens (and vice versa), unconfigured cap
 *     allowed
 *   - structured rejection envelope: `{ ok: false, reason: 'rate_limited',
 *     retryAfterSec }`
 *
 * Strategy: the firestore admin client is mocked at the
 * `@/lib/firebase-admin` boundary. We do NOT spin up the emulator from
 * this suite (the emulator-driven harness lands with wave 1.7); instead
 * we drive the transaction + collection apis through jest mocks so the
 * unit tests stay fast and hermetic.
 */

import { Capability, type Actor } from '@/lib/capabilities';

/* -------------------------------------------------------------------------- */
/*  firestore admin mock — minimal in-memory shard store                      */
/* -------------------------------------------------------------------------- */

interface ShardDoc {
  count: number;
  windowStart: number;
}

// Map keyed by absolute path → shard doc. Reset between tests via beforeEach.
const fakeStore = new Map<string, ShardDoc>();

// Fail-mode toggles (per-test).
let failTransaction = false;
let failGetAll = false;

// Spy on transaction invocations so tests can assert call counts.
const transactionSpy = jest.fn();

function makeDocRef(path: string) {
  return {
    __path: path,
    get: jest.fn(async () => {
      if (failGetAll) throw new Error('mock firestore get failure');
      const data = fakeStore.get(path);
      return {
        exists: !!data,
        data: () => data,
      };
    }),
    set: jest.fn(async (data: ShardDoc) => {
      fakeStore.set(path, data);
    }),
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string) {
  return {
    __path: path,
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    get: jest.fn(async () => {
      if (failGetAll) throw new Error('mock firestore listing failure');
      const docs: Array<{ id: string; data: () => ShardDoc }> = [];
      for (const [key, value] of fakeStore) {
        if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
          docs.push({
            id: key.slice(path.length + 1),
            data: () => value,
          });
        }
      }
      return {
        forEach: (cb: (d: { id: string; data: () => ShardDoc }) => void) => {
          docs.forEach(cb);
        },
      };
    }),
  };
}

const fakeDb = {
  collection: (name: string) => makeCollectionRef(name),
  runTransaction: jest.fn(
    async <T>(handler: (tx: unknown) => Promise<T>): Promise<T> => {
      transactionSpy();
      if (failTransaction) throw new Error('mock firestore transaction failure');
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (data: ShardDoc) => Promise<void> }, data: ShardDoc) => {
          // Synchronous in mock; the real txn `set` is staged inside the
          // transaction and not awaited by the caller.
          void ref.set(data);
        },
      };
      return handler(tx);
    }
  ),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks so the module under test resolves them.
import {
  USER_LIMITS,
  SYSTEM_LIMITS,
  WINDOW_SEC,
  SHARD_COUNT,
  bucketForActor,
  actorIdentifier,
  checkInMemoryBurst,
  checkFirestoreLimit,
  checkRateLimit,
  pickShardIndex,
  __resetInMemoryBucketsForTests,
} from '@/lib/rateLimit.server';

/* -------------------------------------------------------------------------- */
/*  test fixtures                                                             */
/* -------------------------------------------------------------------------- */

const userActor: Actor = {
  type: 'user',
  userId: 'user-1',
  role: 'admin',
  sites: ['site-1'],
};

const otherUserActor: Actor = {
  type: 'user',
  userId: 'user-2',
  role: 'admin',
  sites: ['site-1'],
};

const systemActor: Actor = {
  type: 'system',
  name: 'cortex_autonomous',
  siteId: 'site-1',
};

beforeEach(() => {
  fakeStore.clear();
  failTransaction = false;
  failGetAll = false;
  transactionSpy.mockClear();
  fakeDb.runTransaction.mockClear();
  __resetInMemoryBucketsForTests();
  jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic shard 0
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  default limits                                                            */
/* -------------------------------------------------------------------------- */

describe('default limits', () => {
  it('declares a per-minute limit for every capability in the user bucket', () => {
    for (const cap of Object.values(Capability)) {
      expect(USER_LIMITS[cap]).toBeDefined();
      expect(USER_LIMITS[cap].perMinute).toBeGreaterThan(0);
    }
  });

  it('declares a per-minute limit for every capability in the system bucket', () => {
    for (const cap of Object.values(Capability)) {
      expect(SYSTEM_LIMITS[cap]).toBeDefined();
      expect(SYSTEM_LIMITS[cap].perMinute).toBeGreaterThan(0);
    }
  });

  it('grants system limits >= user limits for every capability (cortex headroom)', () => {
    for (const cap of Object.values(Capability)) {
      expect(SYSTEM_LIMITS[cap].perMinute).toBeGreaterThanOrEqual(
        USER_LIMITS[cap].perMinute
      );
    }
  });

  it('matches the brief for hot-path capabilities', () => {
    expect(USER_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute).toBe(60);
    expect(USER_LIMITS[Capability.DEPLOYMENT_MANAGE].perMinute).toBe(30);
    expect(SYSTEM_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute).toBe(300);
  });
});

/* -------------------------------------------------------------------------- */
/*  small helpers                                                             */
/* -------------------------------------------------------------------------- */

describe('bucketForActor', () => {
  it('routes user actors to the user bucket', () => {
    expect(bucketForActor(userActor)).toBe('user');
  });

  it('routes system actors to the system bucket', () => {
    expect(bucketForActor(systemActor)).toBe('system');
  });
});

describe('actorIdentifier', () => {
  it('uses userId for user actors', () => {
    expect(actorIdentifier(userActor)).toBe('user-1');
  });

  it('uses name for system actors', () => {
    expect(actorIdentifier(systemActor)).toBe('cortex_autonomous');
  });
});

/* -------------------------------------------------------------------------- */
/*  layer 1 — in-memory token bucket                                          */
/* -------------------------------------------------------------------------- */

describe('checkInMemoryBurst', () => {
  it('allows the first request from a fresh actor', () => {
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
  });

  it('allows up to capacity within the same instant', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
  });

  it('keys separately by userId — two users do not share a bucket', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute;
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    // user-1 is now empty; user-2 starts fresh.
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
    expect(checkInMemoryBurst(otherUserActor, Capability.USER_DELETE)).toBe(true);
  });

  it('keys separately by capability — exhausting one does not affect another', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute;
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
    expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('keys separately by actor type — system actor does NOT consume user bucket', () => {
    const userLimit = USER_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute;
    for (let i = 0; i < userLimit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(false);
    // The system actor still has its own untouched bucket.
    expect(checkInMemoryBurst(systemActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('refills tokens proportionally as time passes', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    const start = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);

    // Advance time enough for at least one token to refill (5 tokens/min →
    // 1 token per 12 seconds).
    jest.spyOn(Date, 'now').mockReturnValue(start + 13_000);
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    // The next call should reject again (refill is gradual, not full).
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  layer 2 — firestore sharded counter                                       */
/* -------------------------------------------------------------------------- */

describe('checkFirestoreLimit', () => {
  it('allows the first call and stamps shard 0 with count=1', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toEqual({ ok: true });
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // The store should have exactly one shard recorded.
    const storedKeys = [...fakeStore.keys()];
    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).toContain('/user/MACHINE_EXEC_COMMAND/');
    expect(storedKeys[0]).toMatch(/\/0$/); // shard index 0
    const stored = fakeStore.get(storedKeys[0])!;
    expect(stored.count).toBe(1);
  });

  it('returns rate_limited with retryAfterSec once the summed total exceeds limit', async () => {
    // Pre-populate shard 0 with `count = limit` in the active window so
    // the increment we perform pushes total past `limit`.
    const limit = 3;
    const nowSec = Math.floor(Date.now() / 1000);
    const path = `sites/site-1/rate_limits/user/MACHINE_REMOVE/shards/shards/0`;
    fakeStore.set(path, { count: limit, windowStart: nowSec });

    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_REMOVE,
      limit
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSec).toBeLessThanOrEqual(WINDOW_SEC);
  });

  it('rolls a stale window forward when the existing windowStart is older than windowSec', async () => {
    // Existing shard has count=999 but its window expired.
    const oldStart = Math.floor(Date.now() / 1000) - (WINDOW_SEC + 5);
    const path = `sites/site-1/rate_limits/user/MACHINE_REMOVE/shards/shards/0`;
    fakeStore.set(path, { count: 999, windowStart: oldStart });

    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_REMOVE,
      5
    );
    expect(result).toEqual({ ok: true });

    // Window should have rolled — count=1, windowStart is fresh.
    const stored = fakeStore.get(path)!;
    expect(stored.count).toBe(1);
    expect(stored.windowStart).toBeGreaterThan(oldStart);
  });

  it('separates user and system bucket counters at distinct firestore paths', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await checkFirestoreLimit('site-1', 'user', Capability.MACHINE_EXEC_COMMAND, 60);
    await checkFirestoreLimit('site-1', 'system', Capability.MACHINE_EXEC_COMMAND, 300);

    const keys = [...fakeStore.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.includes('/rate_limits/user/MACHINE_EXEC_COMMAND/'))).toBe(true);
    expect(keys.some((k) => k.includes('/rate_limits/system/MACHINE_EXEC_COMMAND/'))).toBe(true);
  });

  it('distributes increments across all shards when Math.random varies', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < SHARD_COUNT; i++) {
      jest.spyOn(Math, 'random').mockReturnValue(i / SHARD_COUNT);
      await checkFirestoreLimit(
        'site-1',
        'user',
        Capability.MACHINE_EXEC_COMMAND,
        100
      );
      seen.add(i);
    }
    // We should have written into each of the 10 shard slots exactly once.
    const shardKeys = [...fakeStore.keys()].filter((k) =>
      k.includes('/rate_limits/user/MACHINE_EXEC_COMMAND/shards/shards/')
    );
    expect(shardKeys).toHaveLength(SHARD_COUNT);
    expect(seen.size).toBe(SHARD_COUNT);
  });

  it('fails open when the firestore transaction throws', async () => {
    failTransaction = true;
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toEqual({ ok: true });
  });

  it('fails open when the shard read throws after a successful increment', async () => {
    // The transaction succeeds, but the subsequent `col.get()` throws —
    // simulating a partial firestore failure mid-call.
    failGetAll = true;
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects immediately when limit is zero or negative', async () => {
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      0
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rate_limited');
    // No transaction should have been issued.
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

describe('pickShardIndex', () => {
  it('returns an integer in [0, SHARD_COUNT)', () => {
    jest.restoreAllMocks();
    for (let i = 0; i < 100; i++) {
      const idx = pickShardIndex();
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(SHARD_COUNT);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  combined entry point                                                      */
/* -------------------------------------------------------------------------- */

describe('checkRateLimit (combined)', () => {
  it('returns ok:true under normal conditions and writes to the user bucket', async () => {
    const result = await checkRateLimit(
      userActor,
      Capability.MACHINE_EXEC_COMMAND,
      'site-1'
    );
    expect(result).toEqual({ ok: true });
    const keys = [...fakeStore.keys()];
    expect(keys.some((k) => k.includes('/rate_limits/user/MACHINE_EXEC_COMMAND/'))).toBe(true);
  });

  it('routes system actors to the system bucket — never the user bucket', async () => {
    const result = await checkRateLimit(
      systemActor,
      Capability.MACHINE_EXEC_COMMAND,
      'site-1'
    );
    expect(result).toEqual({ ok: true });
    const keys = [...fakeStore.keys()];
    expect(keys.some((k) => k.includes('/rate_limits/system/MACHINE_EXEC_COMMAND/'))).toBe(true);
    expect(keys.some((k) => k.includes('/rate_limits/user/MACHINE_EXEC_COMMAND/'))).toBe(false);
  });

  it('user-bucket exhaustion does NOT block a system actor on the same capability+site', async () => {
    // Saturate the user bucket on shard 0.
    const userLimit = USER_LIMITS[Capability.MACHINE_REMOVE].perMinute;
    const path = `sites/site-1/rate_limits/user/MACHINE_REMOVE/shards/shards/0`;
    fakeStore.set(path, {
      count: userLimit,
      windowStart: Math.floor(Date.now() / 1000),
    });

    const userResult = await checkRateLimit(
      userActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(userResult.ok).toBe(false);

    // The system actor uses a separate in-memory key prefix already, but
    // we reset to belt-and-braces guarantee the firestore layer is what
    // we're checking.
    __resetInMemoryBucketsForTests();
    const systemResult = await checkRateLimit(
      systemActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(systemResult).toEqual({ ok: true });
  });

  it('system-bucket exhaustion does NOT block a user actor on the same capability+site', async () => {
    const systemLimit = SYSTEM_LIMITS[Capability.MACHINE_REMOVE].perMinute;
    const path = `sites/site-1/rate_limits/system/MACHINE_REMOVE/shards/shards/0`;
    fakeStore.set(path, {
      count: systemLimit,
      windowStart: Math.floor(Date.now() / 1000),
    });

    const systemResult = await checkRateLimit(
      systemActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(systemResult.ok).toBe(false);

    __resetInMemoryBucketsForTests();
    const userResult = await checkRateLimit(
      userActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(userResult).toEqual({ ok: true });
  });

  it('short-circuits on in-memory layer without ever hitting firestore', async () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    // Drain the in-memory bucket (firestore allows all of these — limit is 5).
    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit(userActor, Capability.USER_DELETE, 'site-1');
      expect(r.ok).toBe(true);
    }
    transactionSpy.mockClear();
    const denied = await checkRateLimit(userActor, Capability.USER_DELETE, 'site-1');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.reason).toBe('rate_limited');
    expect(denied.retryAfterSec).toBe(WINDOW_SEC);
    // Firestore was NOT consulted on the rejected call.
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('returns the structured rate_limited envelope verbatim on rejection', async () => {
    // USER_SELF_DELETE has a per-minute limit of 1; second call rejects.
    const ok = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');
    expect(ok).toEqual({ ok: true });
    const denied = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.reason).toBe('rate_limited');
    expect(typeof denied.retryAfterSec).toBe('number');
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});
