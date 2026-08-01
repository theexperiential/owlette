/** @jest-environment node */

/**
 * Route-level tests for GET /api/billing/snapshot (billing-system wave 2.5).
 *
 * What a regression here would break silently:
 *   - one account reading another's bill (the whole response is derived from
 *     the *verified* uid — nothing in the request selects an account),
 *   - the projection disagreeing with the invoice: the 3-machine pro minimum,
 *     the storage overage, and the 7-day active-machine window are all
 *     computed here for the customer to read before they are charged,
 *   - an account with no sites, no customer doc, or no usage mirror 500ing
 *     instead of rendering the trial information it is entitled to see.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireSessionOrIdToken = jest.fn();
const mockAssertActiveUser = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
  };
});

/* --------------------------------------------------------------------- */
/*  Firestore fake                                                       */
/* --------------------------------------------------------------------- */

interface FakeSite {
  id: string;
  data: Record<string, unknown>;
  machines: Record<string, unknown>[];
}

/** Docs the fake serves, reset per test. */
const store: {
  customers: Record<string, Record<string, unknown> | null>;
  sitesByOwner: Record<string, FakeSite[]>;
  usage: Record<string, { id: string; data: Record<string, unknown> }[]>;
  usageThrows: boolean;
  /** The deployment-wide `config/billing` doc; `null` = not created yet. */
  billingConfig: Record<string, unknown> | null;
  billingConfigThrows: boolean;
} = {
  customers: {},
  sitesByOwner: {},
  usage: {},
  usageThrows: false,
  billingConfig: null,
  billingConfigThrows: false,
};

const mockSitesQuery = jest.fn();

function snap(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data ?? undefined };
}

function siteDoc(site: FakeSite) {
  return {
    id: site.id,
    data: () => site.data,
    ref: {
      collection: (name: string) => ({
        get: async () => {
          if (name !== 'machines') throw new Error(`unexpected subcollection ${name}`);
          return { docs: site.machines.map((m) => ({ data: () => m })) };
        },
      }),
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'customers') {
        return { doc: (uid: string) => ({ get: async () => snap(store.customers[uid] ?? null) }) };
      }
      if (name === 'sites') {
        return {
          where: (field: string, op: string, value: string) => {
            mockSitesQuery(field, op, value);
            return {
              get: async () => ({
                docs: (store.sitesByOwner[value] ?? []).map(siteDoc),
              }),
            };
          },
        };
      }
      if (name === 'config') {
        return {
          doc: (docId: string) => ({
            get: async () => {
              if (docId !== 'billing') throw new Error(`unexpected config doc ${docId}`);
              if (store.billingConfigThrows) throw new Error('unavailable');
              return snap(store.billingConfig);
            },
          }),
        };
      }
      if (name === 'billing') {
        return {
          doc: (uid: string) => ({
            collection: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => {
                    if (store.usageThrows) throw new Error('missing index');
                    const docs = store.usage[uid] ?? [];
                    return {
                      empty: docs.length === 0,
                      docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
                    };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
}));

// Keep the real limiter wiring but force an always-allow verdict — the
// in-memory limiter is stateful across tests otherwise.
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return {
    ...actual,
    checkRateLimit: jest.fn(async () => ({
      success: true,
      limit: 100,
      remaining: 99,
      reset: 1_000_000,
    })),
  };
});

import { ApiAuthError } from '@/lib/apiAuth.server';
import { BYTES_PER_GB } from '@/lib/billing/pricing';
import { GET } from '@/app/api/billing/snapshot/route';

const TIB = 1024 ** 4;
const DAY_MS = 24 * 60 * 60 * 1000;

function snapshotReq() {
  return createMockRequest('/api/billing/snapshot');
}

/** A machine doc whose heartbeat is `daysAgo` days old. */
function machine(daysAgo: number) {
  const ms = Date.now() - daysAgo * DAY_MS;
  return { lastHeartbeat: { toMillis: () => ms } };
}

describe('GET /api/billing/snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.customers = {};
    store.sitesByOwner = {};
    store.usage = {};
    store.usageThrows = false;
    store.billingConfig = null;
    store.billingConfigThrows = false;
    mockRequireSessionOrIdToken.mockResolvedValue('uid-owner');
    mockAssertActiveUser.mockResolvedValue({ role: 'member', sites: [] });
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY_TEST;
  });

  /* ----------------------------- auth ----------------------------- */

  it('asks the auth layer to reject agent tokens', async () => {
    // The response enumerates every site the account owns and what it pays; a
    // scraped CLI/agent credential must not reach it.
    await GET(snapshotReq());
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything(), {
      rejectAgentTokens: true,
    });
  });

  it('401s an unauthenticated caller before reading anything', async () => {
    mockRequireSessionOrIdToken.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: No valid session'),
    );

    const { status, body } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'unauthorized' });
    expect(mockSitesQuery).not.toHaveBeenCalled();
  });

  it('403s a soft-deleted account holding a stale session', async () => {
    mockAssertActiveUser.mockRejectedValue(
      new ApiAuthError(403, 'Forbidden: User is deleted or inactive', { code: 'user_inactive' }),
    );

    const { status } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(403);
    expect(mockSitesQuery).not.toHaveBeenCalled();
  });

  it('scopes every read to the verified caller uid', async () => {
    // Owner-only falls out of the addressing: no request parameter selects an
    // account, so there is nothing to tamper with.
    await GET(snapshotReq());
    expect(mockSitesQuery).toHaveBeenCalledWith('owner', '==', 'uid-owner');
  });

  it('never caches a response in a shared cache', async () => {
    const res = await GET(snapshotReq());
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  /* ---------------------------- shape ----------------------------- */

  it('returns an empty-but-valid snapshot for an account with no sites or customer doc', async () => {
    const { status, body } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(200);
    expect(body).toEqual({
      // No customers doc is the documented pre-go-live posture, not an error.
      billingState: 'trialing',
      trialEndsAt: null,
      goLiveAt: null,
      daysLeft: null,
      subscriptionTier: null,
      currentPeriodEnd: null,
      stripeConfigured: false,
      hasBillingAccount: false,
      sites: [],
      usage: null,
      projectedBill: { perSite: [], totalUsd: 0 },
    });
  });

  it('reports the trial countdown while trialing', async () => {
    const endsAt = Date.now() + 5.5 * DAY_MS;
    store.customers['uid-owner'] = { trialEndsAt: { toMillis: () => endsAt } };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.billingState).toBe('trialing');
    expect(body.trialEndsAt).toBe(endsAt);
    // Rounded up: the last partial day still reads as a day left, because the
    // account demonstrably still works.
    expect(body.daysLeft).toBe(6);
  });

  it('keeps daysLeft null for the pre-go-live sentinel', async () => {
    store.customers['uid-owner'] = { trialEndsAt: null };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.billingState).toBe('trialing');
    expect(body.trialEndsAt).toBeNull();
    expect(body.daysLeft).toBeNull();
  });

  it('reports expired once the trial clock has run out', async () => {
    store.customers['uid-owner'] = { trialEndsAt: { toMillis: () => Date.now() - DAY_MS } };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.billingState).toBe('expired');
    expect(body.daysLeft).toBeNull();
  });

  it('reports the subscribed tier and renewal date', async () => {
    const renews = Date.now() + 20 * DAY_MS;
    store.customers['uid-owner'] = {
      subscriptionStatus: 'active',
      subscriptionTier: 'pro',
      stripeCustomerId: 'cus_owner',
      currentPeriodEnd: { toMillis: () => renews },
    };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body).toMatchObject({
      billingState: 'active',
      subscriptionTier: 'pro',
      currentPeriodEnd: renews,
      hasBillingAccount: true,
      daysLeft: null,
    });
  });

  it('omits an unrecognised subscriptionTier rather than guessing', async () => {
    store.customers['uid-owner'] = { subscriptionStatus: 'active', subscriptionTier: 'platinum' };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.subscriptionTier).toBeNull();
  });

  it('reports stripeConfigured from the deployment environment', async () => {
    process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_configured';

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.stripeConfigured).toBe(true);
  });

  /* --------------------------- go-live date ------------------------ */

  it('reports goLiveAt null while config/billing has not been created', async () => {
    // Task 5.1 writes that doc when the date is set. Until then the dashboard
    // announcement banner must stay hidden — there is nothing to announce.
    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.goLiveAt).toBeNull();
  });

  it('surfaces the configured go-live date', async () => {
    const t0 = Date.UTC(2026, 8, 1);
    store.billingConfig = { goLiveAt: { toMillis: () => t0 } };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.goLiveAt).toBe(t0);
  });

  it('reports goLiveAt null when the doc exists without a date', async () => {
    // The go-live doc may be created (or cleared) before a date is chosen;
    // `{ goLiveAt: null }` must not become an announcement for the epoch.
    store.billingConfig = { goLiveAt: null };

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.goLiveAt).toBeNull();
  });

  it('still serves the snapshot when the go-live config read fails', async () => {
    // The announcement banner is cosmetic; losing it must never cost the
    // customer the rest of their billing position.
    store.billingConfigThrows = true;
    store.sitesByOwner['uid-owner'] = [
      { id: 'site-a', data: { name: 'atrium', tier: 'core' }, machines: [machine(1)] },
    ];

    const { status, body } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(200);
    expect(body.goLiveAt).toBeNull();
    expect((body.projectedBill as { totalUsd: number }).totalUsd).toBe(10);
  });

  /* -------------------------- machine count ------------------------ */

  it('counts only machines with a heartbeat inside the 7-day window', async () => {
    store.sitesByOwner['uid-owner'] = [
      {
        id: 'site-a',
        data: { name: 'atrium', tier: 'core' },
        machines: [
          machine(0),
          machine(6.9),
          machine(7.5), // stale — outside the window
          { lastHeartbeat: null }, // never checked in
          {}, // no heartbeat field at all
        ],
      },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.sites).toEqual([
      { siteId: 'site-a', name: 'atrium', tier: 'core', activeMachineCount: 2 },
    ]);
  });

  it('falls back to the site id when the site doc has no name', async () => {
    store.sitesByOwner['uid-owner'] = [{ id: 'site-a', data: {}, machines: [] }];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect((body.sites as { name: string }[])[0].name).toBe('site-a');
  });

  it('sorts sites by name', async () => {
    store.sitesByOwner['uid-owner'] = [
      { id: 's2', data: { name: 'zebra', tier: 'core' }, machines: [] },
      { id: 's1', data: { name: 'alpha', tier: 'core' }, machines: [] },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect((body.sites as { name: string }[]).map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });

  /* --------------------------- projection -------------------------- */

  it('applies the 3-machine pro minimum to the projection', async () => {
    store.sitesByOwner['uid-owner'] = [
      { id: 'small', data: { name: 'small', tier: 'pro' }, machines: [machine(1)] },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.projectedBill).toMatchObject({
      perSite: [
        expect.objectContaining({
          siteId: 'small',
          tier: 'pro',
          activeMachineCount: 1,
          billableMachines: 3,
          monthlyUsd: 150,
        }),
      ],
      totalUsd: 150,
    });
  });

  it('sums a mixed core/pro portfolio', async () => {
    store.sitesByOwner['uid-owner'] = [
      {
        id: 'core-site',
        data: { name: 'a-core', tier: 'core' },
        machines: [machine(1), machine(2), machine(3)],
      },
      {
        id: 'pro-site',
        data: { name: 'b-pro', tier: 'pro' },
        machines: [machine(1), machine(2), machine(3), machine(4)],
      },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    // 3 × $10 + 4 × $50
    expect((body.projectedBill as { totalUsd: number }).totalUsd).toBe(230);
  });

  it('adds storage overage from the usage mirror to a pro site', async () => {
    store.sitesByOwner['uid-owner'] = [
      { id: 'pro-site', data: { name: 'pro', tier: 'pro' }, machines: [machine(1), machine(1), machine(1)] },
    ];
    store.usage['uid-owner'] = [
      {
        id: '2026-07-31',
        data: {
          sites: [{ siteId: 'pro-site', storageBytes: TIB + 40 * BYTES_PER_GB, activeMachineCount: 3 }],
          totals: { storageBytes: TIB + 40 * BYTES_PER_GB, activeMachineCount: 3 },
        },
      },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    const perSite = (body.projectedBill as { perSite: Record<string, number>[] }).perSite[0];
    expect(perSite.machinesUsd).toBe(150);
    expect(perSite.storageOverageBytes).toBe(40 * BYTES_PER_GB);
    // 40 GB × $0.05 = $2
    expect(perSite.storageOverageUsd).toBe(2);
    expect(perSite.monthlyUsd).toBe(152);
    expect((body.projectedBill as { totalUsd: number }).totalUsd).toBe(152);
  });

  it('leaves storageBytes null when no usage mirror exists yet', async () => {
    store.sitesByOwner['uid-owner'] = [
      { id: 'pro-site', data: { name: 'pro', tier: 'pro' }, machines: [machine(1)] },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.usage).toBeNull();
    expect(
      (body.projectedBill as { perSite: { storageBytes: number | null }[] }).perSite[0].storageBytes,
    ).toBeNull();
  });

  /* ---------------------------- usage doc -------------------------- */

  it('normalises a usage mirror whose sites are a map keyed by site id', async () => {
    // The cron that writes these lands alongside this route, so both natural
    // shapes (array of rows, map keyed by id) must be readable.
    store.sitesByOwner['uid-owner'] = [
      { id: 'pro-site', data: { name: 'pro', tier: 'pro' }, machines: [] },
    ];
    store.usage['uid-owner'] = [
      {
        id: '2026-07-31',
        data: {
          sites: { 'pro-site': { storageBytes: 512 * BYTES_PER_GB, activeMachineCount: 0 } },
          totals: { storageBytes: 512 * BYTES_PER_GB },
        },
      },
    ];

    const { body } = await parseResponse(await GET(snapshotReq()));

    expect(body.usage).toMatchObject({
      period: '2026-07-31',
      sites: [{ siteId: 'pro-site', storageBytes: 512 * BYTES_PER_GB, activeMachineCount: 0 }],
      totals: { storageBytes: 512 * BYTES_PER_GB },
    });
  });

  it('degrades unreadable usage fields to null instead of throwing', async () => {
    store.usage['uid-owner'] = [{ id: '2026-07-31', data: { sites: 'nonsense', totals: 7 } }];

    const { status, body } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(200);
    expect(body.usage).toEqual({
      period: '2026-07-31',
      sites: [],
      totals: { activeMachineCount: null, storageBytes: null },
    });
  });

  it('still serves the snapshot when the usage subcollection read fails', async () => {
    // The cron that creates `billing/{uid}/usage` has not shipped; a missing
    // collection or index must not take the whole billing tab down.
    store.usageThrows = true;
    store.sitesByOwner['uid-owner'] = [
      { id: 'site-a', data: { name: 'atrium', tier: 'core' }, machines: [machine(1)] },
    ];

    const { status, body } = await parseResponse(await GET(snapshotReq()));

    expect(status).toBe(200);
    expect(body.usage).toBeNull();
    expect((body.projectedBill as { totalUsd: number }).totalUsd).toBe(10);
  });
});
