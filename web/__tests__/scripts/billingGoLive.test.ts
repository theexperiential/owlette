/**
 * @jest-environment node
 */
/**
 * `scripts/billing-go-live.mjs` — the go-live tooling for billing tasks 5.1
 * (announce) and 5.3 (T0 stamp).
 *
 * The script's planning layer is pure by construction: it takes plain
 * `{ id, data }` arrays and returns the writes it would make, so the decisions
 * that matter — who gets a trial clock, which site docs get a tier, when the
 * run must refuse to start — are testable without Firestore, without
 * credentials, and without the script ever running. Module scope has no side
 * effects and `main()` is guarded on being the entry point, so importing it
 * here parses no argv and opens no connection.
 *
 * Three things this file is really protecting:
 *
 * 1. **The hand-mirrors.** The script is ESM and cannot import TypeScript, so
 *    it re-states `TRIAL_LENGTH_DAYS`, `trialEndsAtFrom()`, and the billing
 *    state derivation. Each is asserted against the TypeScript source it
 *    mirrors rather than against a hardcoded expectation, so a change to
 *    either side fails here instead of at T0.
 * 2. **Idempotency.** The stamp is a one-shot fleet-wide write that an
 *    operator may well run twice (a partial failure, a nervous re-run). Both
 *    planners are exercised by feeding their own output back in.
 * 3. **The refusals.** Stamping early, or onto a fleet the customer backfill
 *    has not covered, is the failure this tooling exists to prevent.
 */
import { TRIAL_LENGTH_DAYS as TS_TRIAL_LENGTH_DAYS, trialEndsAtFrom as tsTrialEndsAtFrom } from '@/lib/types/customer';
import type { BillingTimestamp, SubscriptionStatus } from '@/lib/types/customer';
import { resolveBillingState } from '@/lib/billing/billingState';
import { BETA_DEFAULT_TIER } from '@/lib/siteTier';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const goLive = require('../../../scripts/billing-go-live.mjs');

const {
  TRIAL_LENGTH_DAYS,
  GO_LIVE_SITE_TIER,
  billingTimestampToMillis,
  trialEndsAtFrom,
  deriveBillingState,
  parseGoLiveInput,
  checkStampPrereqs,
  planCustomerStamps,
  planSiteStamps,
  summarizeState,
  describeRelative,
} = goLive;

/** A fixed instant so nothing here depends on when the suite runs. */
const NOW = new Date('2026-09-15T17:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

interface Doc {
  id: string;
  data: Record<string, unknown>;
}

const doc = (id: string, data: Record<string, unknown> = {}): Doc => ({ id, data });

/** A customers doc with the pre-go-live sentinel: no clock, no subscription. */
const nullClockCustomer = (id: string, extra: Record<string, unknown> = {}): Doc =>
  doc(id, {
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    subscriptionTier: null,
    trialEndsAt: null,
    billingState: 'trialing',
    ...extra,
  });

/** Apply a plan the way the script's write path does, returning fresh docs. */
function applyCustomerPlan(customers: Doc[], writes: { uid: string; trialEndsAt: Date; billingState: string }[]): Doc[] {
  const byUid = new Map(writes.map((w) => [w.uid, w]));
  return customers.map((c) => {
    const write = byUid.get(c.id);
    if (!write) return c;
    return doc(c.id, { ...c.data, trialEndsAt: write.trialEndsAt, billingState: write.billingState });
  });
}

function applySitePlan(sites: Doc[], writes: { siteId: string; tier: string }[]): Doc[] {
  const bySiteId = new Map(writes.map((w) => [w.siteId, w]));
  return sites.map((s) => {
    const write = bySiteId.get(s.id);
    if (!write) return s;
    // Only `tier` is written — `tierUpgradedAt` is deliberately untouched.
    return doc(s.id, { ...s.data, tier: write.tier });
  });
}

describe('billing-go-live: hand-mirrored constants', () => {
  it('trial length matches web/lib/types/customer.ts', () => {
    expect(TRIAL_LENGTH_DAYS).toBe(TS_TRIAL_LENGTH_DAYS);
    expect(TRIAL_LENGTH_DAYS).toBe(14);
  });

  it('trialEndsAtFrom matches the TypeScript source exactly', () => {
    for (const iso of ['2026-09-15T17:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z']) {
      const start = new Date(iso);
      expect(trialEndsAtFrom(start).toISOString()).toBe(tsTrialEndsAtFrom(start).toISOString());
    }
  });

  it('stamps the tier the beta fallback already resolves to', () => {
    // The whole "stamping preserves behaviour" claim: an unstamped site reads
    // as BETA_DEFAULT_TIER today, so writing that same value is what makes
    // deleting the fallback in the same deploy a no-op for every customer.
    expect(GO_LIVE_SITE_TIER).toBe(BETA_DEFAULT_TIER);
  });
});

describe('billing-go-live: billingTimestampToMillis', () => {
  const expected = Date.UTC(2026, 8, 15, 17, 0, 0);

  it.each<[string, BillingTimestamp]>([
    ['Date', new Date(expected)],
    ['epoch millis', expected],
    ['ISO string', '2026-09-15T17:00:00.000Z'],
    ['admin Timestamp', { toMillis: () => expected }],
    ['{ seconds }', { seconds: expected / 1000 }],
    ['{ _seconds }', { _seconds: expected / 1000 }],
  ])('reads %s', (_label, value) => {
    expect(billingTimestampToMillis(value)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['garbage string', 'not-a-date'],
    ['NaN', Number.NaN],
    ['Invalid Date', new Date('nope')],
    ['object with no time', { foo: 'bar' }],
  ])('returns null for %s', (_label, value) => {
    expect(billingTimestampToMillis(value)).toBeNull();
  });

  it('returns null when toMillis throws', () => {
    expect(
      billingTimestampToMillis({
        toMillis: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });
});

describe('billing-go-live: deriveBillingState', () => {
  // Cross-checked against the real resolver rather than against hardcoded
  // expectations — this is the point of the test. If `resolveBillingState()`
  // ever changes an arm, the mirror in the script fails here.
  const statuses: (SubscriptionStatus | string | null | undefined)[] = [
    'active',
    'past_due',
    'canceled',
    'incomplete',
    'unpaid', // an un-normalised Stripe status
    null,
    undefined,
  ];
  const clocks: (BillingTimestamp | null)[] = [
    null,
    new Date(NOW.getTime() + DAY_MS),
    new Date(NOW.getTime() - DAY_MS),
    new Date(NOW.getTime()), // the exact boundary
    'not-a-date',
  ];

  it('agrees with resolveBillingState across the full matrix', () => {
    for (const subscriptionStatus of statuses) {
      for (const trialEndsAt of clocks) {
        const customer = { subscriptionStatus, trialEndsAt };
        expect(deriveBillingState(customer, NOW)).toBe(resolveBillingState(customer, NOW));
      }
    }
  });

  it('treats a clock ending exactly now as expired', () => {
    expect(deriveBillingState({ subscriptionStatus: null, trialEndsAt: NOW }, NOW)).toBe('expired');
  });

  it('fails open to trialing on an unreadable clock', () => {
    expect(deriveBillingState({ subscriptionStatus: null, trialEndsAt: 'garbage' }, NOW)).toBe('trialing');
  });
});

describe('billing-go-live: parseGoLiveInput (announce)', () => {
  it.each([
    ['omitted', undefined],
    ['bare --golive with no value', true],
    ['empty string', ''],
  ])('refuses a %s date', (_label, raw) => {
    const result = parseGoLiveInput(raw, NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing');
  });

  it('refuses an unparseable date', () => {
    const result = parseGoLiveInput('next tuesday', NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unparseable');
    expect(result.date).toBeUndefined();
  });

  it('refuses a past date but still returns it for --force', () => {
    const result = parseGoLiveInput('2026-09-14T17:00:00Z', NOW);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('past');
    // --force needs the parsed value to go ahead with.
    expect(result.date.toISOString()).toBe('2026-09-14T17:00:00.000Z');
  });

  it('accepts a future date', () => {
    const result = parseGoLiveInput('2026-10-01T00:00:00Z', NOW);
    expect(result.ok).toBe(true);
    expect(result.date.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('accepts an instant exactly equal to now', () => {
    // The refusal is on `< now`, so announcing "right now" is legal.
    expect(parseGoLiveInput(NOW.toISOString(), NOW).ok).toBe(true);
  });

  it('reads a bare calendar date as UTC midnight', () => {
    const result = parseGoLiveInput('2026-10-01', NOW);
    expect(result.ok).toBe(true);
    expect(result.date.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('billing-go-live: checkStampPrereqs', () => {
  const passedGoLive = NOW.getTime() - DAY_MS;

  it('passes with every account covered and go-live behind us', () => {
    const result = checkStampPrereqs({
      users: [doc('u1'), doc('u2')],
      customerIds: ['u1', 'u2'],
      goLiveAtMs: passedGoLive,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.missingCustomerUids).toEqual([]);
  });

  it('refuses when a live account has no customers doc, and names the backfill', () => {
    const result = checkStampPrereqs({
      users: [doc('u1'), doc('u2'), doc('u3')],
      customerIds: ['u1'],
      goLiveAtMs: passedGoLive,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    const blocker = result.blockers.find((b: { code: string }) => b.code === 'missing_customers');
    expect(blocker.count).toBe(2);
    expect(blocker.sample).toEqual(['u2', 'u3']);
    expect(blocker.message).toContain('backfill-customers.mjs');
    expect(result.missingCustomerUids).toEqual(['u2', 'u3']);
  });

  it('exempts soft-deleted users — the backfill skips them on purpose', () => {
    const result = checkStampPrereqs({
      users: [doc('u1'), doc('gone', { deletedAt: new Date('2026-01-01') })],
      customerIds: ['u1'],
      goLiveAtMs: passedGoLive,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.missingCustomerUids).toEqual([]);
  });

  it('refuses when goLiveAt was never announced', () => {
    const result = checkStampPrereqs({
      users: [doc('u1')],
      customerIds: ['u1'],
      goLiveAtMs: null,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b: { code: string }) => b.code)).toEqual(['golive_unset']);
    expect(result.blockers[0].message).toContain('announce');
  });

  it('refuses when the announced date has not arrived', () => {
    const result = checkStampPrereqs({
      users: [doc('u1')],
      customerIds: ['u1'],
      goLiveAtMs: NOW.getTime() + 1,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b: { code: string }) => b.code)).toEqual(['golive_future']);
  });

  it('allows a run at exactly goLiveAt (the <= boundary bootstrapUser uses)', () => {
    // `trialClockStarted()` in bootstrapUser.server.ts treats `ms <= now` as
    // live. If this were `<`, the script and the signup path would disagree
    // about whether go-live had happened for one tick.
    const result = checkStampPrereqs({
      users: [doc('u1')],
      customerIds: ['u1'],
      goLiveAtMs: NOW.getTime(),
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('reports both blockers together', () => {
    const result = checkStampPrereqs({
      users: [doc('u1')],
      customerIds: [],
      goLiveAtMs: null,
      now: NOW,
    });
    expect(result.blockers.map((b: { code: string }) => b.code)).toEqual([
      'missing_customers',
      'golive_unset',
    ]);
  });

  it('accepts a Set of customer ids as well as an array', () => {
    const result = checkStampPrereqs({
      users: [doc('u1')],
      customerIds: new Set(['u1']),
      goLiveAtMs: passedGoLive,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('caps the sample at five ids but keeps the true count', () => {
    const users = Array.from({ length: 9 }, (_, i) => doc(`u${i}`));
    const result = checkStampPrereqs({ users, customerIds: [], goLiveAtMs: passedGoLive, now: NOW });
    const blocker = result.blockers[0];
    expect(blocker.count).toBe(9);
    expect(blocker.sample).toHaveLength(5);
  });
});

describe('billing-go-live: planCustomerStamps', () => {
  const goLiveAt = NOW;

  it('stamps goLiveAt + 14d, not now + 14d', () => {
    const later = new Date(NOW.getTime() + 3 * DAY_MS); // operator ran it late
    const plan = planCustomerStamps([nullClockCustomer('u1')], { goLiveAt, now: later });
    expect(plan.trialEndsAt.toISOString()).toBe(
      new Date(goLiveAt.getTime() + 14 * DAY_MS).toISOString(),
    );
    expect(plan.writes[0].trialEndsAt).toBe(plan.trialEndsAt);
  });

  it('writes trialing at T0', () => {
    const plan = planCustomerStamps([nullClockCustomer('u1')], { goLiveAt, now: NOW });
    expect(plan.writes).toEqual([
      { uid: 'u1', trialEndsAt: plan.trialEndsAt, billingState: 'trialing' },
    ]);
    expect(plan.totals).toMatchObject({ total: 1, stamp: 1, alreadyLive: 0, subscribed: 0, wouldExpire: 0 });
  });

  it('skips a doc whose clock is already live', () => {
    const customers = [
      nullClockCustomer('fresh'),
      nullClockCustomer('selfStarted', { trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS) }),
    ];
    const plan = planCustomerStamps(customers, { goLiveAt, now: NOW });
    expect(plan.writes.map((w: { uid: string }) => w.uid)).toEqual(['fresh']);
    expect(plan.totals.alreadyLive).toBe(1);
  });

  it('skips a subscribed account even when it still carries the null sentinel', () => {
    // Subscription outranks the trial clock — handing this account a trial
    // would write a state the resolver would never produce.
    const customers = [
      nullClockCustomer('paying', { subscriptionId: 'sub_123', subscriptionStatus: 'active' }),
      nullClockCustomer('trialing'),
    ];
    const plan = planCustomerStamps(customers, { goLiveAt, now: NOW });
    expect(plan.writes.map((w: { uid: string }) => w.uid)).toEqual(['trialing']);
    expect(plan.totals).toMatchObject({ subscribed: 1, stamp: 1 });
  });

  it('ignores an empty-string subscriptionId', () => {
    const plan = planCustomerStamps([nullClockCustomer('u1', { subscriptionId: '' })], {
      goLiveAt,
      now: NOW,
    });
    expect(plan.totals).toMatchObject({ stamp: 1, subscribed: 0 });
  });

  it('counts accounts a late run would stamp straight into expired', () => {
    // goLiveAt + 14d already behind us: the run is honest about the state it
    // writes rather than quietly extending everyone.
    const veryLate = new Date(NOW.getTime() + 20 * DAY_MS);
    const plan = planCustomerStamps([nullClockCustomer('u1'), nullClockCustomer('u2')], {
      goLiveAt,
      now: veryLate,
    });
    expect(plan.totals.wouldExpire).toBe(2);
    expect(plan.writes.every((w: { billingState: string }) => w.billingState === 'expired')).toBe(true);
  });

  it('tolerates a doc with no data', () => {
    const plan = planCustomerStamps([{ id: 'u1', data: undefined }], { goLiveAt, now: NOW });
    expect(plan.totals.stamp).toBe(1);
  });

  it('is idempotent — replanning against its own output writes nothing', () => {
    const customers = [
      nullClockCustomer('a'),
      nullClockCustomer('b'),
      nullClockCustomer('paying', { subscriptionId: 'sub_1', subscriptionStatus: 'active' }),
      nullClockCustomer('live', { trialEndsAt: new Date(NOW.getTime() + DAY_MS) }),
    ];

    const first = planCustomerStamps(customers, { goLiveAt, now: NOW });
    expect(first.totals.stamp).toBe(2);

    const after = applyCustomerPlan(customers, first.writes);
    const second = planCustomerStamps(after, { goLiveAt, now: NOW });

    expect(second.writes).toEqual([]);
    expect(second.totals).toMatchObject({ total: 4, stamp: 0, alreadyLive: 3, subscribed: 1 });

    // And a third run, to be sure the second didn't just get lucky.
    expect(planCustomerStamps(after, { goLiveAt, now: NOW }).totals.stamp).toBe(0);
  });
});

describe('billing-go-live: planSiteStamps', () => {
  it('stamps only the docs with no explicit tier', () => {
    const sites = [
      doc('missing'),
      doc('nullTier', { tier: null }),
      doc('core', { tier: 'core' }),
      doc('pro', { tier: 'pro' }),
    ];
    const plan = planSiteStamps(sites);
    expect(plan.writes).toEqual([
      { siteId: 'missing', tier: 'pro' },
      { siteId: 'nullTier', tier: 'pro' },
    ]);
    expect(plan.totals).toMatchObject({ total: 4, stamp: 2, alreadyStamped: 2, unknownTier: 0 });
  });

  it('leaves a core site alone — it must not be upgraded by the stamp', () => {
    const plan = planSiteStamps([doc('c', { tier: 'core' })]);
    expect(plan.writes).toEqual([]);
  });

  it('restamps an unrecognised tier and counts it as an anomaly', () => {
    // 'gold' resolves to BETA_DEFAULT_TIER today, so 'pro' preserves that
    // site's behaviour past the fallback deletion.
    const plan = planSiteStamps([doc('weird', { tier: 'gold' }), doc('numeric', { tier: 3 })]);
    expect(plan.writes.map((w: { siteId: string }) => w.siteId)).toEqual(['weird', 'numeric']);
    expect(plan.totals.unknownTier).toBe(2);
  });

  it('never plans a tierUpgradedAt write', () => {
    // This is not an upgrade — it records the tier the site already had.
    const plan = planSiteStamps([doc('missing'), doc('legacy', { tierUpgradedAt: null })]);
    for (const write of plan.writes) {
      expect(Object.keys(write).sort()).toEqual(['siteId', 'tier']);
    }
  });

  it('compares the raw stored field, not a resolved tier', () => {
    // A resolved comparison would read every unstamped doc as 'pro' already
    // and plan nothing — leaving the fleet on the fallback this stamp exists
    // to make deletable.
    expect(planSiteStamps([doc('unstamped')]).totals.stamp).toBe(1);
  });

  it('is idempotent — replanning against its own output writes nothing', () => {
    const sites = [doc('a'), doc('b', { tier: 'core' }), doc('c', { tier: 'gold' })];

    const first = planSiteStamps(sites);
    expect(first.totals.stamp).toBe(2);

    const after = applySitePlan(sites, first.writes);
    const second = planSiteStamps(after);

    expect(second.writes).toEqual([]);
    expect(second.totals).toMatchObject({ total: 3, stamp: 0, alreadyStamped: 3, unknownTier: 0 });
    expect(planSiteStamps(after).totals.stamp).toBe(0);
  });
});

describe('billing-go-live: summarizeState (status)', () => {
  const users = [doc('u1'), doc('u2'), doc('u3'), doc('deleted', { deletedAt: new Date('2026-01-01') })];
  const customers = [
    nullClockCustomer('u1'),
    nullClockCustomer('u2', { trialEndsAt: new Date(NOW.getTime() + DAY_MS) }),
    nullClockCustomer('u3', { trialEndsAt: new Date(NOW.getTime() - DAY_MS) }),
    nullClockCustomer('u4', { subscriptionId: 'sub_1', subscriptionStatus: 'active' }),
  ];
  const sites = [doc('s1'), doc('s2', { tier: 'pro' }), doc('s3', { tier: 'core' })];

  it('splits customers into exclusive buckets that sum to the total', () => {
    const report = summarizeState({ users, customers, sites, goLiveAtMs: NOW.getTime(), now: NOW });
    const { total, subscribed, nullClock, liveClock, expired } = report.customers;
    expect({ total, subscribed, nullClock, liveClock, expired }).toEqual({
      total: 4,
      subscribed: 1,
      nullClock: 1,
      liveClock: 2,
      expired: 1, // a sub-count of liveClock, not a fourth bucket
    });
    expect(subscribed + nullClock + liveClock).toBe(total);
  });

  it('counts unstamped sites and reports pending work', () => {
    const report = summarizeState({ users, customers, sites, goLiveAtMs: NOW.getTime(), now: NOW });
    expect(report.sites).toEqual({ total: 3, stamped: 2, unstamped: 1 });
    expect(report.stampPending).toBe(true);
  });

  it('reports goLiveAt state', () => {
    expect(summarizeState({ users, customers, sites, goLiveAtMs: null, now: NOW }).goLiveHasPassed).toBe(false);
    expect(
      summarizeState({ users, customers, sites, goLiveAtMs: NOW.getTime(), now: NOW }).goLiveHasPassed,
    ).toBe(true);
    expect(
      summarizeState({ users, customers, sites, goLiveAtMs: NOW.getTime() + 1, now: NOW }).goLiveHasPassed,
    ).toBe(false);
  });

  it('surfaces the missing-customers prereq without counting soft-deleted users', () => {
    const report = summarizeState({
      users,
      customers: customers.slice(0, 2),
      sites,
      goLiveAtMs: NOW.getTime(),
      now: NOW,
    });
    expect(report.users).toEqual({ total: 4, missingCustomerDoc: 1 }); // u3 only
    expect(report.prereqs.ok).toBe(false);
  });

  it('reports no pending work once the stamp has run', () => {
    const goLiveAt = NOW;
    const stampedCustomers = applyCustomerPlan(
      customers,
      planCustomerStamps(customers, { goLiveAt, now: NOW }).writes,
    );
    const stampedSites = applySitePlan(sites, planSiteStamps(sites).writes);

    const report = summarizeState({
      users,
      customers: stampedCustomers,
      sites: stampedSites,
      goLiveAtMs: goLiveAt.getTime(),
      now: NOW,
    });

    expect(report.customers.nullClock).toBe(0);
    expect(report.sites.unstamped).toBe(0);
    expect(report.stampPending).toBe(false);
    expect(report.prereqs.ok).toBe(true);
  });
});

describe('billing-go-live: end-to-end stamp idempotency', () => {
  it('a full T0 run reaches a fixed point after one pass', () => {
    const goLiveAt = NOW;
    const users = [doc('u1'), doc('u2'), doc('u3'), doc('gone', { deletedAt: new Date('2026-01-01') })];
    let customers = [
      nullClockCustomer('u1'),
      nullClockCustomer('u2'),
      nullClockCustomer('u3', { subscriptionId: 'sub_9', subscriptionStatus: 'active' }),
    ];
    let sites = [doc('s1'), doc('s2', { tier: 'core' }), doc('s3', { tier: 'gold' }), doc('s4')];

    // pre-flight
    const before = checkStampPrereqs({
      users,
      customerIds: customers.map((c) => c.id),
      goLiveAtMs: goLiveAt.getTime(),
      now: NOW,
    });
    expect(before.ok).toBe(true);

    // pass 1
    const customerPlan = planCustomerStamps(customers, { goLiveAt, now: NOW });
    const sitePlan = planSiteStamps(sites);
    expect(customerPlan.totals.stamp).toBe(2);
    expect(sitePlan.totals.stamp).toBe(3);
    customers = applyCustomerPlan(customers, customerPlan.writes);
    sites = applySitePlan(sites, sitePlan.writes);

    // pass 2 — the fixed point
    expect(planCustomerStamps(customers, { goLiveAt, now: NOW }).totals.stamp).toBe(0);
    expect(planSiteStamps(sites).totals.stamp).toBe(0);

    // Every doc the script stamped now carries a `billingState` mirror the
    // real web-side resolver agrees with — a cached mirror that disagreed
    // with the resolver would be a lie the whole app reads.
    for (const uid of customerPlan.writes.map((w: { uid: string }) => w.uid)) {
      const stamped = customers.find((c) => c.id === uid)!.data as {
        subscriptionStatus?: SubscriptionStatus | string | null;
        trialEndsAt?: BillingTimestamp | null;
        billingState?: string;
      };
      expect(resolveBillingState(stamped, NOW)).toBe(stamped.billingState);
    }

    // The subscribed account was not touched at all — Stripe's webhook owns
    // its state, and the script must not write a trial clock over it.
    expect(customers.find((c) => c.id === 'u3')!.data.trialEndsAt).toBeNull();

    const report = summarizeState({ users, customers, sites, goLiveAtMs: goLiveAt.getTime(), now: NOW });
    expect(report.stampPending).toBe(false);
  });
});

describe('billing-go-live: describeRelative', () => {
  it.each([
    [0, 'today'],
    [DAY_MS, 'in 1 day'],
    [30 * DAY_MS, 'in 30 days'],
    [-DAY_MS, '1 day ago'],
    [-14 * DAY_MS, '14 days ago'],
  ])('renders %i ms as "%s"', (deltaMs, expected) => {
    expect(describeRelative(NOW.getTime() + deltaMs, NOW)).toBe(expected);
  });
});
