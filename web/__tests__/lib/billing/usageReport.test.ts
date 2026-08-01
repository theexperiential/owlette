/** @jest-environment node */

/**
 * Metered usage reporting (billing-system waves 2.3 + 2.4).
 *
 * Covers `runUsageReport()` and the pure helpers it bills from. The Stripe
 * SDK is mocked at the `@/lib/stripe.server` boundary, matching
 * `stripeCustomer.test.ts` — these pin OUR contract (the 3-machine floor,
 * the seven-day window, the overage math, rerun safety) rather than the
 * SDK's internals.
 *
 * The failures that would be invisible in production:
 *   - the pro floor leaking onto core sites — every core customer overbilled 3×,
 *   - a heartbeat parsed as unreadable — the machine silently stops being billed,
 *   - a same-day rerun re-posting — with `last` aggregation that is survivable,
 *     but with the ledger gone it is the only thing standing between a retry
 *     storm and a wrong invoice,
 *   - one broken account aborting the sweep — the rest of the fleet loses its
 *     billing day and nobody finds out until the invoices are wrong,
 *   - a Stripe call while unconfigured — every pre-go-live morning pages someone.
 */

const mockGetStripeOrNull = jest.fn();
const mockStripeMode = jest.fn(() => 'test');

jest.mock('@/lib/stripe.server', () => ({
  getStripeOrNull: () => mockGetStripeOrNull(),
  stripeMode: () => mockStripeMode(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(() => {
    throw new Error('getAdminDb() must not be reached — inject `db`');
  }),
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  runUsageReport,
  billedMachinesFor,
  storageOverageBytesFor,
  storageOverageGbFor,
  formatUsagePeriod,
  usageEventIdentifier,
  MACHINE_METER_EVENT_NAMES,
  STORAGE_OVERAGE_METER_EVENT_NAME,
  ACTIVE_MACHINE_WINDOW_DAYS,
  PRO_MINIMUM_MACHINES,
  BYTES_PER_GIB,
} from '@/lib/billing/usageReport.server';

const TIB = 1024 ** 4;
const NOW = new Date('2026-08-01T03:00:00.000Z');
const PERIOD = '2026-08-01';
const WINDOW_MS = ACTIVE_MACHINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Exactly on the seven-day boundary — the value the window must exclude. */
const CUTOFF_MS = NOW.getTime() - WINDOW_MS;

/* ─── fake firestore ───────────────────────────────────────────────────── */

interface FakeMachine {
  id: string;
  lastHeartbeat?: unknown;
}

interface FakeSite {
  id: string;
  owner: string;
  /** Omitted entirely for a legacy doc, which must resolve to the beta default. */
  tier?: string;
  machines?: FakeMachine[];
  /** `null`/omitted models a site whose reconcile has never run. */
  quota?: Record<string, unknown> | null;
}

/** Firestore `Timestamp` stand-in — the shape the agent actually writes. */
function ts(millis: number) {
  return { toMillis: () => millis };
}

class FakeDb {
  customers: Record<string, Record<string, unknown>> = {};
  sites: FakeSite[] = [];
  /** Mirror docs, keyed `${uid}/${period}`. Pre-seed to model a prior run. */
  usage = new Map<string, Record<string, unknown>>();
  /** Every mirror write, in order. */
  usageWrites: Array<{ key: string; data: Record<string, unknown> }> = [];

  private siteRef(site: FakeSite) {
    return {
      collection: (name: string) => {
        if (name === 'machines') {
          return {
            get: async () => ({
              docs: (site.machines ?? []).map((m) => ({
                id: m.id,
                data: () => ({ lastHeartbeat: m.lastHeartbeat }),
              })),
            }),
          };
        }
        if (name === 'roost') {
          return {
            doc: (id: string) => ({
              get: async () => {
                const data = id === 'quota' ? site.quota : null;
                return { exists: data != null, data: () => data ?? undefined };
              },
            }),
          };
        }
        throw new Error(`unexpected site subcollection: ${name}`);
      },
    };
  }

  collection(name: string) {
    if (name === 'customers') {
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => {
            const docs = Object.entries(this.customers)
              .filter(([, data]) => op === '==' && data[field] === value)
              .map(([id, data]) => ({ id, data: () => ({ ...data }) }));
            return { size: docs.length, docs };
          },
        }),
      };
    }

    if (name === 'sites') {
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => ({
            docs: this.sites
              .filter((s) => op === '==' && (s as unknown as Record<string, unknown>)[field] === value)
              .map((s) => ({
                id: s.id,
                data: () => (s.tier === undefined ? {} : { tier: s.tier }),
                ref: this.siteRef(s),
              })),
          }),
        }),
      };
    }

    if (name === 'billing') {
      return {
        doc: (uid: string) => ({
          collection: (sub: string) => {
            if (sub !== 'usage') throw new Error(`unexpected billing subcollection: ${sub}`);
            return {
              doc: (period: string) => {
                const key = `${uid}/${period}`;
                return {
                  get: async () => {
                    const data = this.usage.get(key);
                    return { exists: data !== undefined, data: () => data };
                  },
                  set: async (data: Record<string, unknown>) => {
                    this.usageWrites.push({ key, data });
                    this.usage.set(key, { ...(this.usage.get(key) ?? {}), ...data });
                  },
                };
              },
            };
          },
        }),
      };
    }

    throw new Error(`unexpected collection: ${name}`);
  }
}

function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}

/** A customer doc that passes every eligibility check. */
function activeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    billingState: 'active',
    subscriptionStatus: 'active',
    subscriptionId: 'sub_123',
    stripeCustomerId: 'cus_123',
    trialEndsAt: null,
    ...overrides,
  };
}

let meterEventCreate: jest.Mock;

/** Install a Stripe stub whose `meterEvents.create` records every call. */
function configureStripe(impl?: (params: Record<string, unknown>) => unknown) {
  meterEventCreate = jest.fn(async (params: Record<string, unknown>) =>
    impl ? impl(params) : { object: 'billing.meter_event' },
  );
  mockGetStripeOrNull.mockReturnValue({
    billing: { meterEvents: { create: meterEventCreate } },
  });
}

/** All meter events posted for one meter, in call order. */
function eventsFor(eventName: string) {
  return meterEventCreate.mock.calls
    .map(([params]) => params as Record<string, string>)
    .filter((p) => p.event_name === eventName);
}

/** The single value posted for a meter. Fails loudly if it wasn't posted once. */
function valueFor(eventName: string): string {
  const events = eventsFor(eventName);
  expect(events).toHaveLength(1);
  return (events[0].payload as unknown as Record<string, string>).value;
}

/* ─── pure helpers ─────────────────────────────────────────────────────── */

describe('billedMachinesFor', () => {
  it('applies the 3-machine minimum to pro only', () => {
    expect(billedMachinesFor('pro', 0)).toBe(PRO_MINIMUM_MACHINES);
    expect(billedMachinesFor('pro', 1)).toBe(PRO_MINIMUM_MACHINES);
    expect(billedMachinesFor('pro', 2)).toBe(PRO_MINIMUM_MACHINES);
    // At and above the floor the real count wins — the minimum is a floor,
    // never a cap.
    expect(billedMachinesFor('pro', 3)).toBe(3);
    expect(billedMachinesFor('pro', 9)).toBe(9);
  });

  it('bills core its raw count, with no floor', () => {
    expect(billedMachinesFor('core', 0)).toBe(0);
    expect(billedMachinesFor('core', 1)).toBe(1);
    expect(billedMachinesFor('core', 2)).toBe(2);
    expect(billedMachinesFor('core', 9)).toBe(9);
  });
});

describe('storage overage math', () => {
  it('is zero at and below the 1 TiB inclusion', () => {
    expect(storageOverageBytesFor('pro', 0, TIB)).toBe(0);
    expect(storageOverageBytesFor('pro', TIB - 1, TIB)).toBe(0);
    // Exactly at the cap is inside the allowance, not over it.
    expect(storageOverageBytesFor('pro', TIB, TIB)).toBe(0);
    expect(storageOverageGbFor(storageOverageBytesFor('pro', TIB, TIB))).toBe(0);
  });

  it('charges whole GiB past the inclusion', () => {
    expect(storageOverageGbFor(storageOverageBytesFor('pro', TIB + 3 * BYTES_PER_GIB, TIB))).toBe(3);
    expect(storageOverageGbFor(storageOverageBytesFor('pro', TIB + 250 * BYTES_PER_GIB, TIB))).toBe(250);
  });

  it('floors a partial GiB rather than rounding it up', () => {
    // A site three megabytes over owes nothing — the rounding error is
    // deliberately on the customer's side of the line.
    expect(storageOverageGbFor(storageOverageBytesFor('pro', TIB + 3_000_000, TIB))).toBe(0);
    expect(
      storageOverageGbFor(storageOverageBytesFor('pro', TIB + 3.9 * BYTES_PER_GIB, TIB)),
    ).toBe(3);
  });

  it('never accrues overage on a core site, whose inclusion is zero', () => {
    // Subtracting a zero inclusion would report the whole footprint as
    // overage and bill it at the PRO rate.
    expect(storageOverageBytesFor('core', 5 * BYTES_PER_GIB, 0)).toBe(0);
    expect(storageOverageBytesFor('core', 5 * TIB, TIB)).toBe(0);
  });
});

describe('formatUsagePeriod', () => {
  it('is the UTC day, regardless of the host clock', () => {
    expect(formatUsagePeriod(NOW)).toBe(PERIOD);
    // 23:30 UTC is still the same UTC day even where local time has rolled over.
    expect(formatUsagePeriod(new Date('2026-08-01T23:30:00.000Z'))).toBe('2026-08-01');
  });
});

describe('usageEventIdentifier', () => {
  it('is deterministic and inside Stripe\'s 100-character limit', () => {
    const uid = 'a'.repeat(28);
    const id = usageEventIdentifier(STORAGE_OVERAGE_METER_EVENT_NAME, uid, PERIOD);
    expect(id).toBe(`${STORAGE_OVERAGE_METER_EVENT_NAME}-${uid}-${PERIOD}`);
    expect(id).toBe(usageEventIdentifier(STORAGE_OVERAGE_METER_EVENT_NAME, uid, PERIOD));
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

/* ─── runUsageReport ───────────────────────────────────────────────────── */

describe('runUsageReport', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = new FakeDb();
    mockStripeMode.mockReturnValue('test');
    configureStripe();
  });

  it('skips cleanly when stripe is unconfigured, touching neither stripe nor firestore', async () => {
    mockGetStripeOrNull.mockReturnValue(null);
    mockStripeMode.mockReturnValue('unconfigured');
    db.customers.u1 = activeCustomer();

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.ok).toBe(true);
    expect(summary.skipped).toBe('unconfigured');
    expect(summary.period).toBe(PERIOD);
    expect(summary.mode).toBe('unconfigured');
    expect(summary.customers).toEqual({ scanned: 0, eligible: 0, failed: 0 });
    expect(meterEventCreate).not.toHaveBeenCalled();
    expect(db.usageWrites).toHaveLength(0);
  });

  it('reports the pro floor for a pro site and the raw count for a core site', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-pro',
        owner: 'u1',
        tier: 'pro',
        machines: [{ id: 'm1', lastHeartbeat: ts(NOW.getTime() - 1000) }],
      },
      {
        id: 'site-core',
        owner: 'u1',
        tier: 'core',
        machines: [
          { id: 'm2', lastHeartbeat: ts(NOW.getTime() - 1000) },
          { id: 'm3', lastHeartbeat: ts(NOW.getTime() - 1000) },
        ],
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    // One machine on pro bills as three; two on core bill as two.
    expect(valueFor(MACHINE_METER_EVENT_NAMES.pro)).toBe('3');
    expect(valueFor(MACHINE_METER_EVENT_NAMES.core)).toBe('2');
    expect(summary.totals).toEqual({
      activeMachines: 3,
      coreMachines: 2,
      proMachines: 3,
      storageOverageGb: 0,
    });
    expect(summary.customers).toEqual({ scanned: 1, eligible: 1, failed: 0 });
  });

  it('bills a pro site with no machines at the minimum', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'site-pro', owner: 'u1', tier: 'pro', machines: [] }];

    await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(MACHINE_METER_EVENT_NAMES.pro)).toBe('3');
    expect(valueFor(MACHINE_METER_EVENT_NAMES.core)).toBe('0');
  });

  it('excludes a heartbeat exactly on the seven-day boundary', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-core',
        owner: 'u1',
        tier: 'core',
        machines: [
          // Exactly 7d old — outside the window.
          { id: 'boundary', lastHeartbeat: ts(CUTOFF_MS) },
          // One millisecond older still — outside.
          { id: 'stale', lastHeartbeat: ts(CUTOFF_MS - 1) },
          // One millisecond fresher — inside.
          { id: 'fresh', lastHeartbeat: ts(CUTOFF_MS + 1) },
        ],
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.activeMachines).toBe(1);
    expect(valueFor(MACHINE_METER_EVENT_NAMES.core)).toBe('1');
  });

  it('excludes machines with a missing or unreadable heartbeat', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-core',
        owner: 'u1',
        tier: 'core',
        machines: [
          { id: 'never-checked-in' },
          { id: 'null-heartbeat', lastHeartbeat: null },
          { id: 'garbage', lastHeartbeat: 'not-a-date' },
          { id: 'fresh', lastHeartbeat: ts(NOW.getTime() - 1000) },
        ],
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.activeMachines).toBe(1);
  });

  it('reads the legacy timestamp shapes an agent may have written', async () => {
    db.customers.u1 = activeCustomer();
    const freshMs = NOW.getTime() - 1000;
    db.sites = [
      {
        id: 'site-core',
        owner: 'u1',
        tier: 'core',
        machines: [
          { id: 'epoch-millis', lastHeartbeat: freshMs },
          { id: 'iso-string', lastHeartbeat: new Date(freshMs).toISOString() },
          { id: 'seconds-pair', lastHeartbeat: { seconds: Math.floor(freshMs / 1000) } },
          { id: 'underscored', lastHeartbeat: { _seconds: Math.floor(freshMs / 1000) } },
          { id: 'to-date', lastHeartbeat: { toDate: () => new Date(freshMs) } },
        ],
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.activeMachines).toBe(5);
  });

  it('ignores the online flag, which says nothing about a seven-day window', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-core',
        owner: 'u1',
        tier: 'core',
        machines: [
          // Gracefully shut down: `online: false`, but a real recent contact.
          { id: 'shut-down', lastHeartbeat: ts(NOW.getTime() - 1000) },
        ],
      },
    ];
    // The fake never surfaces `online`, so a reader that depended on it would
    // read undefined and drop the machine.
    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.activeMachines).toBe(1);
  });

  it('treats an untiered legacy site as pro, matching getSiteTier', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'legacy', owner: 'u1', machines: [] }];

    await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(MACHINE_METER_EVENT_NAMES.pro)).toBe('3');
  });

  it('reports storage overage past the 1 TiB inclusion', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-a',
        owner: 'u1',
        tier: 'pro',
        machines: [],
        quota: { usedBytes: TIB + 10 * BYTES_PER_GIB },
      },
      {
        id: 'site-b',
        owner: 'u1',
        tier: 'pro',
        machines: [],
        quota: { usedBytes: TIB + 5 * BYTES_PER_GIB },
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(STORAGE_OVERAGE_METER_EVENT_NAME)).toBe('15');
    expect(summary.totals.storageOverageGb).toBe(15);
  });

  it('sums exact bytes across sites before rounding once', async () => {
    db.customers.u1 = activeCustomer();
    // Two sites each 0.6 GiB over: flooring per site would bill 0, but the
    // account is genuinely 1.2 GiB over.
    db.sites = [
      { id: 'a', owner: 'u1', tier: 'pro', machines: [], quota: { usedBytes: TIB + 0.6 * BYTES_PER_GIB } },
      { id: 'b', owner: 'u1', tier: 'pro', machines: [], quota: { usedBytes: TIB + 0.6 * BYTES_PER_GIB } },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.storageOverageGb).toBe(1);
  });

  it('does not bill a core site holding roost data from a downgrade', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'downgraded',
        owner: 'u1',
        tier: 'core',
        machines: [],
        // Core's inclusion is 0, so a naive subtraction would report all
        // 5 GiB as overage and bill it at the pro rate.
        quota: { usedBytes: 5 * BYTES_PER_GIB },
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(STORAGE_OVERAGE_METER_EVENT_NAME)).toBe('0');
    expect(summary.totals.storageOverageGb).toBe(0);
    // …but the footprint is still mirrored, so the billing tab can show it.
    const mirror = db.usage.get(`u1/${PERIOD}`)!;
    expect((mirror.sites as Array<Record<string, unknown>>)[0].storageUsedBytes).toBe(
      5 * BYTES_PER_GIB,
    );
  });

  it('reports zero overage for a site with no quota doc', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'pro', machines: [], quota: null }];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(STORAGE_OVERAGE_METER_EVENT_NAME)).toBe('0');
    expect(summary.totals.storageOverageGb).toBe(0);
  });

  it('honours a one-off grant in planLimitBytes over the tier inclusion', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'granted',
        owner: 'u1',
        tier: 'pro',
        machines: [],
        // 2 TiB granted; 1.5 TiB used is inside it and owes nothing.
        quota: { usedBytes: TIB + 512 * BYTES_PER_GIB, planLimitBytes: 2 * TIB },
      },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.storageOverageGb).toBe(0);
  });

  it('bills the site-doc tier, not the stale tier cached on the quota doc', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'downgraded',
        owner: 'u1',
        tier: 'core',
        machines: [{ id: 'm1', lastHeartbeat: ts(NOW.getTime() - 1000) }],
        // The quota doc still claims pro — quotaEnforce documents this copy
        // as a cache, and billing it would charge core at pro rates.
        quota: { tier: 'pro', usedBytes: 0 },
      },
    ];

    await runUsageReport({ db: asDb(db), now: NOW });

    expect(valueFor(MACHINE_METER_EVENT_NAMES.core)).toBe('1');
    expect(valueFor(MACHINE_METER_EVENT_NAMES.pro)).toBe('0');
  });

  it('posts every meter with a deterministic identifier and the customer id', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'pro', machines: [] }];

    await runUsageReport({ db: asDb(db), now: NOW });

    expect(meterEventCreate).toHaveBeenCalledTimes(3);
    for (const [params] of meterEventCreate.mock.calls) {
      const p = params as Record<string, unknown>;
      expect(p.identifier).toBe(
        usageEventIdentifier(p.event_name as string, 'u1', PERIOD),
      );
      expect(p.payload).toEqual({
        stripe_customer_id: 'cus_123',
        // Stripe types the payload as a string map.
        value: expect.any(String),
      });
      expect(p.timestamp).toBe(Math.floor(NOW.getTime() / 1000));
    }
  });

  it('mirrors the per-site breakdown and totals for the billing tab', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [
      {
        id: 'site-pro',
        owner: 'u1',
        tier: 'pro',
        machines: [{ id: 'm1', lastHeartbeat: ts(NOW.getTime() - 1000) }],
        quota: { usedBytes: TIB + 2 * BYTES_PER_GIB },
      },
    ];

    await runUsageReport({ db: asDb(db), now: NOW });

    const mirror = db.usage.get(`u1/${PERIOD}`)!;
    expect(mirror.period).toBe(PERIOD);
    expect(mirror.stripeCustomerId).toBe('cus_123');
    expect(mirror.subscriptionId).toBe('sub_123');
    expect(mirror.sites).toEqual([
      {
        siteId: 'site-pro',
        tier: 'pro',
        activeMachines: 1,
        billedMachines: 3,
        storageUsedBytes: TIB + 2 * BYTES_PER_GIB,
        storageLimitBytes: TIB,
        storageOverageBytes: 2 * BYTES_PER_GIB,
      },
    ]);
    expect(mirror.totals).toEqual({
      sites: 1,
      activeMachines: 1,
      coreMachines: 0,
      proMachines: 3,
      storageOverageBytes: 2 * BYTES_PER_GIB,
      storageOverageGb: 2,
    });
    // The ledger that makes the rerun a no-op.
    expect(Object.keys(mirror.meterEvents as Record<string, unknown>).sort()).toEqual([
      'coreMachines',
      'proMachines',
      'storageOverageGb',
    ]);
  });

  it('does not re-post on a same-day rerun', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'pro', machines: [] }];

    const first = await runUsageReport({ db: asDb(db), now: NOW });
    expect(first.meterEvents).toEqual({ sent: 3, alreadyReported: 0 });

    const second = await runUsageReport({ db: asDb(db), now: NOW });

    // Still three calls in total — the rerun posted nothing.
    expect(meterEventCreate).toHaveBeenCalledTimes(3);
    expect(second.meterEvents).toEqual({ sent: 0, alreadyReported: 3 });
    // …and it still refreshed the mirror, so the billing tab isn't stale.
    expect(db.usageWrites).toHaveLength(2);

    // A rerun sends no events, so the ledger it writes back is built purely
    // from what it read. If that write dropped the existing entries, the
    // NEXT run would happily re-post all three.
    const third = await runUsageReport({ db: asDb(db), now: NOW });
    expect(third.meterEvents).toEqual({ sent: 0, alreadyReported: 3 });
    expect(meterEventCreate).toHaveBeenCalledTimes(3);
    expect(
      Object.keys((db.usage.get(`u1/${PERIOD}`)!.meterEvents as Record<string, unknown>)).sort(),
    ).toEqual(['coreMachines', 'proMachines', 'storageOverageGb']);
  });

  it('re-posts on the next day, under a new period', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'pro', machines: [] }];

    await runUsageReport({ db: asDb(db), now: NOW });
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = await runUsageReport({ db: asDb(db), now: nextDay });

    expect(second.period).toBe('2026-08-02');
    expect(second.meterEvents).toEqual({ sent: 3, alreadyReported: 0 });
    expect(meterEventCreate).toHaveBeenCalledTimes(6);
    expect(db.usage.has(`u1/2026-08-02`)).toBe(true);
  });

  it('resumes a partially-reported period without re-posting what landed', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'pro', machines: [] }];
    // Models a crash after the machine meters posted but before storage did.
    db.usage.set(`u1/${PERIOD}`, {
      meterEvents: {
        coreMachines: { value: 0 },
        proMachines: { value: 3 },
      },
    });

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.meterEvents).toEqual({ sent: 1, alreadyReported: 2 });
    expect(eventsFor(STORAGE_OVERAGE_METER_EVENT_NAME)).toHaveLength(1);
    expect(eventsFor(MACHINE_METER_EVENT_NAMES.pro)).toHaveLength(0);
    // The pre-existing entries survive the write that adds the third.
    const mirror = db.usage.get(`u1/${PERIOD}`)!;
    expect(Object.keys(mirror.meterEvents as Record<string, unknown>).sort()).toEqual([
      'coreMachines',
      'proMachines',
      'storageOverageGb',
    ]);
  });

  it('continues past a failing account and reports it', async () => {
    db.customers.broken = activeCustomer({ stripeCustomerId: 'cus_broken' });
    db.customers.healthy = activeCustomer({ stripeCustomerId: 'cus_healthy' });
    db.sites = [
      { id: 'a', owner: 'broken', tier: 'core', machines: [] },
      {
        id: 'b',
        owner: 'healthy',
        tier: 'core',
        machines: [{ id: 'm1', lastHeartbeat: ts(NOW.getTime() - 1000) }],
      },
    ];
    configureStripe((params) => {
      const payload = params.payload as Record<string, string>;
      if (payload.stripe_customer_id === 'cus_broken') {
        throw new Error('stripe is down');
      }
      return { object: 'billing.meter_event' };
    });

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.customers).toEqual({ scanned: 2, eligible: 2, failed: 1 });
    expect(summary.failures).toEqual([{ uid: 'broken', error: 'stripe is down' }]);
    // The healthy account still got its full day.
    expect(summary.totals.coreMachines).toBe(1);
    expect(db.usage.has(`healthy/${PERIOD}`)).toBe(true);
    // The failed one wrote no ledger, so the next run retries it.
    expect(db.usage.has(`broken/${PERIOD}`)).toBe(false);
  });

  it('continues past a firestore mirror failure', async () => {
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'core', machines: [] }];
    jest.spyOn(db, 'collection').mockImplementation(((name: string) => {
      const real = FakeDb.prototype.collection.call(db, name);
      if (name !== 'billing') return real;
      return {
        doc: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: false, data: () => undefined }),
              set: async () => {
                throw new Error('firestore unavailable');
              },
            }),
          }),
        }),
      };
    }) as typeof db.collection);

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.customers.failed).toBe(1);
    expect(summary.failures[0].error).toBe('firestore unavailable');
  });

  it('skips accounts without a live subscription', async () => {
    db.customers.trialing = { billingState: 'active', subscriptionStatus: null, trialEndsAt: null };
    db.customers.noSubId = activeCustomer({ subscriptionId: null });
    db.customers.noCustomerId = activeCustomer({ stripeCustomerId: '' });
    // Cached mirror says active, but the authoritative resolver disagrees.
    db.customers.staleMirror = activeCustomer({ subscriptionStatus: 'canceled' });
    db.sites = [{ id: 'a', owner: 'trialing', tier: 'pro', machines: [] }];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.customers).toEqual({ scanned: 4, eligible: 0, failed: 0 });
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('reports a past_due account, which keeps service through dunning', async () => {
    db.customers.u1 = activeCustomer({ subscriptionStatus: 'past_due' });
    db.sites = [{ id: 'a', owner: 'u1', tier: 'core', machines: [] }];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.customers.eligible).toBe(1);
    expect(meterEventCreate).toHaveBeenCalledTimes(3);
  });

  it('never bills one account for another account\'s sites', async () => {
    db.customers.u1 = activeCustomer({ stripeCustomerId: 'cus_1' });
    db.sites = [
      { id: 'mine', owner: 'u1', tier: 'core', machines: [{ id: 'm1', lastHeartbeat: ts(NOW.getTime()) }] },
      { id: 'theirs', owner: 'u2', tier: 'core', machines: [{ id: 'm2', lastHeartbeat: ts(NOW.getTime()) }] },
    ];

    const summary = await runUsageReport({ db: asDb(db), now: NOW });

    expect(summary.totals.activeMachines).toBe(1);
    expect(valueFor(MACHINE_METER_EVENT_NAMES.core)).toBe('1');
  });

  it('never logs anything resembling a stripe key', async () => {
    const loggerModule = jest.requireMock('@/lib/logger') as {
      default: { error: jest.Mock; info: jest.Mock; debug: jest.Mock };
    };
    db.customers.u1 = activeCustomer();
    db.sites = [{ id: 'a', owner: 'u1', tier: 'core', machines: [] }];

    await runUsageReport({ db: asDb(db), now: NOW });

    const logged = JSON.stringify([
      loggerModule.default.info.mock.calls,
      loggerModule.default.debug.mock.calls,
      loggerModule.default.error.mock.calls,
    ]);
    expect(logged).not.toMatch(/sk_|rk_/);
  });
});
