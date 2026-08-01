/**
 * @jest-environment node
 *
 * Superadmin billing aggregation (billing-system tasks 4.1 + 4.2).
 *
 * Covers the two read surfaces the admin area renders: the customers table's
 * per-row projection (live state resolution, comp detection, stale mirrors,
 * search + filter + cap) and the ops overview's arithmetic (population counts,
 * the MRR projection from usage mirrors, trial conversion, and the storage
 * leaderboard including a one-off grant that must not read as an overage).
 */

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    throw new Error('getAdminDb() must not be reached — inject `db`');
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => ({ __op: 'delete' }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
  FieldPath: { documentId: () => '__name__' },
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  FROM_EMAIL: 'noreply@example.com',
  isProduction: false,
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  buildBillingOverview,
  listBillingCustomers,
  STORAGE_ALERT_FRACTION,
} from '@/lib/billing/billingOps.server';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 5 * MS_PER_DAY);
const PAST = new Date(NOW.getTime() - 5 * MS_PER_DAY);

/* ─── firestore fake ───────────────────────────────────────────────────── */

interface FakeSite {
  id: string;
  owner?: string;
  tier?: string;
  quota?: { usedBytes?: number; planLimitBytes?: number };
}

class FakeDb {
  customers: Record<string, Record<string, unknown>> = {};
  users: Record<string, Record<string, unknown>> = {};
  sites: FakeSite[] = [];
  /** `billing/{uid}/usage/{period}` payloads, keyed `uid/period`. */
  usage: Record<string, Record<string, unknown>> = {};

  private siteRef(site: FakeSite) {
    return {
      collection: (name: string) => {
        if (name !== 'roost') throw new Error(`unexpected site subcollection: ${name}`);
        return {
          doc: (id: string) => ({
            get: async () => {
              const data = id === 'quota' ? site.quota : undefined;
              return { exists: data !== undefined, data: () => data };
            },
          }),
        };
      },
    };
  }

  private usageQuery(uid: string) {
    const query = {
      orderBy: () => query,
      limit: (n: number) => ({
        get: async () => {
          const periods = Object.keys(this.usage)
            .filter((key) => key.startsWith(`${uid}/`))
            .map((key) => key.slice(uid.length + 1))
            .sort()
            .reverse()
            .slice(0, n);
          return {
            empty: periods.length === 0,
            docs: periods.map((period) => ({
              id: period,
              data: () => this.usage[`${uid}/${period}`],
            })),
          };
        },
      }),
    };
    return query;
  }

  collection(name: string) {
    if (name === 'customers') {
      return {
        get: async () => ({
          docs: Object.entries(this.customers).map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
          })),
        }),
      };
    }
    if (name === 'users') {
      return {
        get: async () => ({
          docs: Object.entries(this.users).map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
          })),
        }),
        doc: (id: string) => ({
          get: async () => {
            const data = this.users[id];
            return { exists: data !== undefined, data: () => data };
          },
        }),
      };
    }
    if (name === 'sites') {
      return {
        get: async () => ({
          docs: this.sites.map((site) => ({
            id: site.id,
            data: () => ({ owner: site.owner, tier: site.tier }),
            ref: this.siteRef(site),
          })),
        }),
      };
    }
    if (name === 'billing') {
      return {
        doc: (uid: string) => ({
          collection: (sub: string) => {
            if (sub !== 'usage') throw new Error(`unexpected billing subcollection: ${sub}`);
            return this.usageQuery(uid);
          },
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

/* ─── customers list ───────────────────────────────────────────────────── */

function listFixture(): FakeDb {
  const db = new FakeDb();
  db.customers = {
    u_trial: { trialEndsAt: FUTURE, billingState: 'trialing' },
    // Stored mirror still says trialing; the clock says otherwise.
    u_lapsed: { trialEndsAt: PAST, billingState: 'trialing' },
    u_paid: {
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      subscriptionTier: 'pro',
      trialEndsAt: PAST,
      billingState: 'active',
    },
    u_comp: {
      trialEndsAt: FUTURE,
      subscriptionTier: 'pro',
      compedTier: 'pro',
      compedAt: PAST,
      compedBy: 'uid_admin',
      compNote: 'conference sponsor',
      billingState: 'trialing',
    },
    u_orphan: { trialEndsAt: FUTURE, billingState: 'trialing' },
  };
  db.users = {
    u_trial: { email: 'ana@fleet.test', displayName: 'Ana' },
    u_lapsed: { email: 'bo@fleet.test' },
    u_paid: { email: 'cy@fleet.test' },
    u_comp: { email: 'di@fleet.test', deletedAt: 1700000000000 },
    // u_orphan deliberately has no users doc.
  };
  return db;
}

const list = (db: FakeDb, options: Record<string, unknown> = {}) =>
  listBillingCustomers({ db: db.asFirestore(), now: NOW, ...options });

describe('listBillingCustomers', () => {
  it('resolves state live and flags a mirror that disagrees', async () => {
    const { customers } = await list(listFixture());
    const lapsed = customers.find((c) => c.uid === 'u_lapsed')!;

    expect(lapsed.billingState).toBe('expired');
    expect(lapsed.staleMirror).toBe('trialing');

    const trialing = customers.find((c) => c.uid === 'u_trial')!;
    expect(trialing.billingState).toBe('trialing');
    expect(trialing.staleMirror).toBeNull();
  });

  it('joins the user profile, including the soft-delete marker', async () => {
    const { customers } = await list(listFixture());

    expect(customers.find((c) => c.uid === 'u_trial')).toMatchObject({
      email: 'ana@fleet.test',
      displayName: 'Ana',
      deleted: false,
    });
    expect(customers.find((c) => c.uid === 'u_comp')!.deleted).toBe(true);
    expect(customers.find((c) => c.uid === 'u_orphan')).toMatchObject({
      email: null,
      displayName: null,
    });
  });

  it('surfaces comp provenance only for a live comp', async () => {
    const { customers } = await list(listFixture());

    expect(customers.find((c) => c.uid === 'u_comp')).toMatchObject({
      comped: true,
      comp: { by: 'uid_admin', note: 'conference sponsor', at: PAST.getTime() },
    });
    // Paying account on the same tier — never labelled comped.
    expect(customers.find((c) => c.uid === 'u_paid')).toMatchObject({
      comped: false,
      comp: null,
      hasSubscription: true,
      subscriptionStatus: 'active',
    });
  });

  it('sorts by email and puts accounts with no user doc last', async () => {
    const { customers } = await list(listFixture());
    expect(customers.map((c) => c.uid)).toEqual([
      'u_trial', // ana@
      'u_lapsed', // bo@
      'u_paid', // cy@
      'u_comp', // di@
      'u_orphan', // no email
    ]);
  });

  it('filters by resolved state, not the stored mirror', async () => {
    const { customers, matched, total } = await list(listFixture(), { state: 'expired' });
    expect(customers.map((c) => c.uid)).toEqual(['u_lapsed']);
    expect(matched).toBe(1);
    expect(total).toBe(5);
  });

  it('searches uid, email, and display name case-insensitively', async () => {
    expect((await list(listFixture(), { query: 'ANA@' })).customers.map((c) => c.uid)).toEqual([
      'u_trial',
    ]);
    expect((await list(listFixture(), { query: 'u_orphan' })).customers.map((c) => c.uid)).toEqual([
      'u_orphan',
    ]);
    expect((await list(listFixture(), { query: 'ana' })).customers.map((c) => c.uid)).toEqual([
      'u_trial',
    ]);
    expect((await list(listFixture(), { query: 'nobody' })).customers).toEqual([]);
  });

  it('caps rows at the limit and says so', async () => {
    const result = await list(listFixture(), { limit: 2 });
    expect(result.customers).toHaveLength(2);
    expect(result.matched).toBe(5);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when everything fits', async () => {
    const result = await list(listFixture());
    expect(result.truncated).toBe(false);
    expect(result.customers).toHaveLength(5);
  });

  it('reports the trial clock and the alert mute', async () => {
    const db = listFixture();
    db.customers.u_muted = {
      trialEndsAt: new Date(NOW.getTime() - 40 * MS_PER_DAY),
      alertEmailsDisabledAt: PAST,
    };
    db.users.u_muted = { email: 'ed@fleet.test' };

    const { customers } = await list(db);
    const muted = customers.find((c) => c.uid === 'u_muted')!;

    expect(muted.alertEmailsMuted).toBe(true);
    expect(muted.trialEndsAt).toBe(NOW.getTime() - 40 * MS_PER_DAY);
    expect(customers.find((c) => c.uid === 'u_trial')!.alertEmailsMuted).toBe(false);
  });
});

/* ─── overview ─────────────────────────────────────────────────────────── */

function overviewFixture(): FakeDb {
  const db = new FakeDb();
  db.customers = {
    // Subscribed, converted from a trial. Pro site, 5 machines, 10 GiB over.
    u_pro: {
      subscriptionStatus: 'active',
      subscriptionTier: 'pro',
      subscriptionId: 'sub_pro',
      trialEndsAt: PAST,
    },
    // Subscribed, converted. Core site, 2 machines.
    u_core: {
      subscriptionStatus: 'past_due',
      subscriptionTier: 'core',
      subscriptionId: 'sub_core',
      trialEndsAt: PAST,
    },
    // Subscribed but never ran a trial — must not inflate the conversion rate.
    u_legacy: {
      subscriptionStatus: 'active',
      subscriptionTier: 'pro',
      subscriptionId: 'sub_legacy',
      trialEndsAt: null,
    },
    u_trialing: { trialEndsAt: FUTURE },
    u_expired: { trialEndsAt: PAST },
    u_canceled: { subscriptionStatus: 'canceled', subscriptionTier: 'core' },
    u_comped: {
      trialEndsAt: FUTURE,
      subscriptionTier: 'pro',
      compedTier: 'pro',
      compedAt: PAST,
    },
  };
  db.users = {
    u_pro: { email: 'pro@fleet.test' },
    u_core: { email: 'core@fleet.test' },
    u_grant: { email: 'grant@fleet.test' },
    u_near: { email: 'near@fleet.test' },
    u_legacy: { email: 'legacy@fleet.test' },
  };
  db.sites = [
    // 1.2 TiB against a 1 TiB inclusion — over.
    { id: 's_pro', owner: 'u_pro', tier: 'pro', quota: { usedBytes: 1.2 * TIB } },
    // 0.95 TiB against 1 TiB — approaching, not over.
    { id: 's_near', owner: 'u_near', tier: 'pro', quota: { usedBytes: 0.95 * TIB } },
    // 1.5 TiB against a 2 TiB one-off grant — biggest user, but NOT flagged.
    {
      id: 's_grant',
      owner: 'u_grant',
      tier: 'pro',
      quota: { usedBytes: 1.5 * TIB, planLimitBytes: 2 * TIB },
    },
    // Legacy bytes on a core site: counted as used, no allowance, no overage.
    { id: 's_core', owner: 'u_core', tier: 'core', quota: { usedBytes: 5 * GIB } },
    // No quota doc at all — the common case today.
    { id: 's_bare', owner: 'u_trialing', tier: 'pro' },
    // Ownerless site: skipped rather than crashing the aggregation.
    { id: 's_orphan', tier: 'pro', quota: { usedBytes: 9 * TIB } },
  ];
  db.usage = {
    'u_pro/2026-07-31': {
      sites: [
        {
          siteId: 's_pro',
          tier: 'pro',
          activeMachines: 5,
          storageUsedBytes: TIB + 10 * GIB,
        },
      ],
    },
    'u_pro/2026-07-30': { sites: [{ siteId: 's_pro', tier: 'pro', activeMachines: 99 }] },
    'u_core/2026-07-31': {
      sites: [{ siteId: 's_core', tier: 'core', activeMachines: 2, storageUsedBytes: 5 * GIB }],
    },
    // u_legacy has no mirror — counted in `accounts`, absent from `withUsage`.
  };
  return db;
}

const overview = (db: FakeDb) => buildBillingOverview({ db: db.asFirestore(), now: NOW });

describe('buildBillingOverview — population', () => {
  it('counts accounts by resolved state', async () => {
    const result = await overview(overviewFixture());
    expect(result.customers.total).toBe(7);
    expect(result.customers.byState).toEqual({
      trialing: 2, // u_trialing, u_comped
      active: 3, // u_pro, u_core (past_due), u_legacy
      expired: 1, // u_expired
      canceled: 1, // u_canceled
    });
  });

  it('counts accounts by tier, with no-tier its own bucket', async () => {
    const result = await overview(overviewFixture());
    expect(result.customers.byTier).toEqual({ core: 2, pro: 3, none: 2 });
  });

  it('counts live comps', async () => {
    const result = await overview(overviewFixture());
    // Only u_comped: u_pro and u_legacy carry a subscription, so their pro
    // tier is paid for even though it matches.
    expect(result.customers.comped).toBe(1);
  });

  it('stamps the run time', async () => {
    const result = await overview(overviewFixture());
    expect(result.generatedAt).toBe(NOW.getTime());
  });
});

describe('buildBillingOverview — mrr projection', () => {
  it('projects from the newest usage mirror per subscribed account', async () => {
    const result = await overview(overviewFixture());

    // u_pro: max(3, 5) = 5 machines × $50 = $250, plus 10 GiB over 1 TiB at
    // $0.05/GiB = $0.50. u_core: 2 machines × $10 = $20, no storage charge on
    // core. The 2026-07-30 mirror (99 machines) must be ignored.
    expect(result.mrr.projectedUsd).toBe(270.5);
    expect(result.mrr.latestPeriod).toBe('2026-07-31');
  });

  it('reports usage coverage so a partial projection reads as a floor', async () => {
    const result = await overview(overviewFixture());
    expect(result.mrr.accounts).toBe(3); // u_pro, u_core, u_legacy
    expect(result.mrr.withUsage).toBe(2); // u_legacy has no mirror
  });

  it('is zero when no subscribed account has a mirror', async () => {
    const db = overviewFixture();
    db.usage = {};
    const result = await overview(db);
    expect(result.mrr).toMatchObject({ projectedUsd: 0, withUsage: 0, latestPeriod: null });
  });
});

describe('buildBillingOverview — conversion', () => {
  it('counts only subscribed accounts that ever ran a trial', async () => {
    const result = await overview(overviewFixture());
    // u_pro + u_core converted; u_legacy never had a clock. One expired.
    expect(result.conversion.converted).toBe(2);
    expect(result.conversion.expired).toBe(1);
    expect(result.conversion.rate).toBeCloseTo(2 / 3, 10);
  });

  it('reports a null rate rather than dividing by zero', async () => {
    const db = new FakeDb();
    db.customers = { u_trialing: { trialEndsAt: FUTURE } };
    const result = await overview(db);
    expect(result.conversion).toEqual({ converted: 0, expired: 0, rate: null });
  });
});

describe('buildBillingOverview — storage', () => {
  it('ranks accounts by bytes held and labels them with an email', async () => {
    const result = await overview(overviewFixture());
    expect(result.storage.topAccounts.map((r) => r.uid)).toEqual([
      'u_grant', // 1.5 TiB
      'u_pro', // 1.2 TiB
      'u_near', // 0.95 TiB
      'u_core', // 5 GiB, core
    ]);
    expect(result.storage.topAccounts[0].email).toBe('grant@fleet.test');
  });

  it('omits accounts holding nothing', async () => {
    const result = await overview(overviewFixture());
    expect(result.storage.topAccounts.map((r) => r.uid)).not.toContain('u_trialing');
  });

  it('skips sites with no owner rather than inventing an account', async () => {
    const result = await overview(overviewFixture());
    expect(result.storage.topAccounts.map((r) => r.uid)).not.toContain('s_orphan');
  });

  it('flags accounts at or past the alert fraction, including those over', async () => {
    const result = await overview(overviewFixture());
    expect(result.storage.alertThreshold).toBe(STORAGE_ALERT_FRACTION);
    expect(result.storage.approachingOverage.map((r) => r.uid)).toEqual(['u_pro', 'u_near']);
  });

  it('honours a one-off grant, so a granted account is not falsely flagged', async () => {
    const result = await overview(overviewFixture());
    const grant = result.storage.topAccounts.find((r) => r.uid === 'u_grant')!;

    expect(grant.includedBytes).toBe(2 * TIB);
    expect(grant.usedFraction).toBeCloseTo(0.75, 10);
    expect(grant.overageBytes).toBe(0);
    expect(result.storage.approachingOverage.map((r) => r.uid)).not.toContain('u_grant');
  });

  it('gives a core site no allowance and therefore no overage', async () => {
    const result = await overview(overviewFixture());
    const core = result.storage.topAccounts.find((r) => r.uid === 'u_core')!;

    expect(core.usedBytes).toBe(5 * GIB);
    expect(core.includedBytes).toBe(0);
    expect(core.usedFraction).toBeNull();
    expect(core.overageBytes).toBe(0);
  });

  it('reports exact overage bytes for an account past its allowance', async () => {
    const result = await overview(overviewFixture());
    const pro = result.storage.approachingOverage.find((r) => r.uid === 'u_pro')!;

    expect(pro.siteCount).toBe(1);
    expect(pro.overageBytes).toBeCloseTo(0.2 * TIB, 0);
    expect(pro.usedFraction).toBeCloseTo(1.2, 10);
  });
});
