/** @jest-environment node */

// `billingGate.server` pulls in `apiAuth.server` for `ApiAuthError`, which
// transitively loads the session manager and the admin SDK. Neither is
// exercised here — every gate call injects a FakeDb — so both are stubbed to
// keep the module graph cheap and hermetic. Mirrors `apiAuth.test.ts`.
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: jest.fn(() => {
    throw new Error('getAdminDb() must not be reached — inject `db`');
  }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'test-fingerprint'),
}));

import type { Firestore } from 'firebase-admin/firestore';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { Capability } from '@/lib/capabilities';
import { TRIAL_LENGTH_DAYS } from '@/lib/types/customer';
import {
  BILLING_LOCKED_CAPABILITIES,
  billingErrorToProblem,
  billingWarningFor,
  getAccountBillingSnapshot,
  getBillingSnapshot,
  isBillingLockedCapability,
  requireActiveAccountBilling,
  requireActiveBilling,
  requireBillingSnapshot,
  requirePro,
  requireProAccount,
  siteTierOrThrow,
} from '@/lib/billingGate.server';

/* ─── fake firestore ───────────────────────────────────────────────────── */

class FakeDb {
  readonly docs = new Map<string, Record<string, unknown>>();

  collection(path: string) {
    const matchIn = (prefix: string) =>
      Array.from(this.docs.entries())
        .filter(([docPath]) => docPath.startsWith(`${prefix}/`))
        .filter(([docPath]) => !docPath.slice(prefix.length + 1).includes('/'));

    const query = (filters: Array<[string, unknown]>) => ({
      // Equality-only; enough for `sites where owner == uid`.
      where: (field: string, _op: string, value: unknown) =>
        query([...filters, [field, value]]),
      get: async () => ({
        docs: matchIn(path)
          .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
          .map(([docPath, data]) => ({
            id: docPath.slice(path.length + 1),
            data: () => ({ ...data }),
          })),
      }),
    });

    return {
      ...query([]),
      doc: (id: string) => ({
        get: async () => {
          const data = this.docs.get(`${path}/${id}`);
          return {
            exists: data !== undefined,
            data: () => (data ? { ...data } : undefined),
          };
        },
      }),
    };
  }

  seed(path: string, data: Record<string, unknown>): this {
    this.docs.set(path, { ...data });
    return this;
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

const NOW = new Date('2026-08-01T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY);
}

/**
 * A site owned by `owner-1` plus its paired customers doc. `customer: null`
 * seeds the site only — the pre-wave-0.1 account whose billing doc was never
 * minted.
 */
function scenario(opts: {
  tier?: 'core' | 'pro';
  customer?: Record<string, unknown> | null;
  owner?: string | null;
} = {}): FakeDb {
  const db = new FakeDb();
  const owner = opts.owner === undefined ? 'owner-1' : opts.owner;
  db.seed('sites/site-1', {
    name: 'site one',
    ...(owner ? { owner } : {}),
    ...(opts.tier ? { tier: opts.tier } : {}),
  });
  if (owner && opts.customer) db.seed(`customers/${owner}`, opts.customer);
  return db;
}

/** Mid-trial account: clock started, still running. */
const TRIALING = { subscriptionStatus: null, trialEndsAt: daysFromNow(7) };
/** Trial ran out and no subscription was ever created. */
const EXPIRED = { subscriptionStatus: null, trialEndsAt: daysFromNow(-1) };
/** Converted, then canceled — same lockout as expired, different cause. */
const CANCELED = { subscriptionStatus: 'canceled', trialEndsAt: daysFromNow(-1) };
/** Paying customer. */
const ACTIVE = { subscriptionStatus: 'active', trialEndsAt: daysFromNow(-30) };

const opts = (db: FakeDb) => ({ db: db.asFirestore(), now: NOW });

async function expectApiAuthError(
  promise: Promise<unknown>,
): Promise<ApiAuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiAuthError);
    return err as ApiAuthError;
  }
  throw new Error('expected the gate to throw, but it resolved');
}

/* ─── getBillingSnapshot ───────────────────────────────────────────────── */

describe('getBillingSnapshot', () => {
  it('resolves site -> owner -> customer into state + tier', async () => {
    const db = scenario({ tier: 'pro', customer: ACTIVE });

    await expect(getBillingSnapshot('site-1', opts(db))).resolves.toEqual({
      siteId: 'site-1',
      ownerUid: 'owner-1',
      billingState: 'active',
      siteTier: 'pro',
      trialEndsAt: (ACTIVE.trialEndsAt as Date).getTime(),
    });
  });

  it('returns null for a site that does not exist', async () => {
    const db = scenario({ customer: ACTIVE });

    await expect(getBillingSnapshot('nope', opts(db))).resolves.toBeNull();
  });

  it('treats a missing customers doc as trialing (pre-T0 account)', async () => {
    const db = scenario({ tier: 'pro', customer: null });

    const snapshot = await getBillingSnapshot('site-1', opts(db));
    expect(snapshot).toEqual({
      siteId: 'site-1',
      ownerUid: 'owner-1',
      billingState: 'trialing',
      siteTier: 'pro',
      trialEndsAt: null,
    });
  });

  it('treats a null trialEndsAt as trialing (clock not started)', async () => {
    const db = scenario({
      customer: { subscriptionStatus: null, trialEndsAt: null },
    });

    const snapshot = await getBillingSnapshot('site-1', opts(db));
    expect(snapshot?.billingState).toBe('trialing');
  });

  it('falls back to the beta default tier when the site has no tier field', async () => {
    const db = scenario({ customer: ACTIVE });

    const snapshot = await getBillingSnapshot('site-1', opts(db));
    // `getSiteTier()` owns this fallback; it stays 'pro' until task 5.3
    // stamps every site doc.
    expect(snapshot?.siteTier).toBe('pro');
  });

  it('fails open to trialing for an ownerless site', async () => {
    const db = scenario({ tier: 'core', owner: null });

    await expect(getBillingSnapshot('site-1', opts(db))).resolves.toEqual({
      siteId: 'site-1',
      ownerUid: null,
      billingState: 'trialing',
      siteTier: 'core',
      trialEndsAt: null,
    });
  });

  it('reads a Firestore-style {seconds} trialEndsAt', async () => {
    const endsAt = daysFromNow(3);
    const db = scenario({
      customer: {
        subscriptionStatus: null,
        trialEndsAt: { seconds: Math.floor(endsAt.getTime() / 1000) },
      },
    });

    const snapshot = await getBillingSnapshot('site-1', opts(db));
    expect(snapshot?.billingState).toBe('trialing');
    expect(snapshot?.trialEndsAt).toBe(Math.floor(endsAt.getTime() / 1000) * 1000);
  });

  it('surfaces an unparseable trialEndsAt as null (fails open to trialing)', async () => {
    const db = scenario({
      customer: { subscriptionStatus: null, trialEndsAt: 'not-a-date' },
    });

    const snapshot = await getBillingSnapshot('site-1', opts(db));
    expect(snapshot?.billingState).toBe('trialing');
    expect(snapshot?.trialEndsAt).toBeNull();
  });
});

/* ─── billingWarningFor (wave 3.3) ─────────────────────────────────────── */

describe('billingWarningFor', () => {
  const base = { siteId: 'site-1', ownerUid: 'owner-1', siteTier: 'pro' } as const;

  it('formats the trial deadline as an ISO-8601 instant', () => {
    const endsAt = Date.UTC(2026, 7, 15, 9, 30, 0);
    expect(
      billingWarningFor({ ...base, billingState: 'trialing', trialEndsAt: endsAt }),
    ).toBe('trial ends 2026-08-15T09:30:00.000Z; choose a plan to keep API access');
  });

  it('returns null while trialing with no clock (pre-go-live sentinel)', () => {
    expect(
      billingWarningFor({ ...base, billingState: 'trialing', trialEndsAt: null }),
    ).toBeNull();
  });

  it.each(['active', 'expired', 'canceled'] as const)(
    'returns null for billingState %s',
    (billingState) => {
      expect(
        billingWarningFor({ ...base, billingState, trialEndsAt: daysFromNow(7).getTime() }),
      ).toBeNull();
    },
  );
});

/* ─── requireBillingSnapshot ───────────────────────────────────────────── */

describe('requireBillingSnapshot', () => {
  it('throws the shared 404 for a missing site', async () => {
    const db = scenario({ customer: ACTIVE });

    const err = await expectApiAuthError(requireBillingSnapshot('nope', opts(db)));
    // Must match `assertUserHasSiteAccess()` verbatim so the gate can't be
    // used to distinguish "no such site" from "no access to that site".
    expect(err.status).toBe(404);
    expect(err.message).toBe('Site not found');
    expect(err.code).toBeUndefined();
  });
});

/* ─── requireActiveBilling ─────────────────────────────────────────────── */

describe('requireActiveBilling', () => {
  it('passes while trialing', async () => {
    const db = scenario({ customer: TRIALING });

    await expect(requireActiveBilling('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
    });
  });

  it('passes with an active subscription', async () => {
    const db = scenario({ customer: ACTIVE });

    await expect(requireActiveBilling('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'active',
    });
  });

  it('passes when past_due — Stripe dunning owns the recovery window', async () => {
    const db = scenario({
      customer: { subscriptionStatus: 'past_due', trialEndsAt: daysFromNow(-30) },
    });

    await expect(requireActiveBilling('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'active',
    });
  });

  it('throws 402 trial_expired when the trial ran out', async () => {
    const db = scenario({ customer: EXPIRED });

    const err = await expectApiAuthError(requireActiveBilling('site-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.code).toBe('trial_expired');
    expect(err.message).toBe('this free trial has ended; choose a plan to restore access');
    expect(err.details).toEqual({ siteId: 'site-1', billingState: 'expired' });
  });

  it('throws 402 trial_expired when the subscription was canceled', async () => {
    const db = scenario({ customer: CANCELED });

    const err = await expectApiAuthError(requireActiveBilling('site-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.code).toBe('trial_expired');
    // Same code, different wording — the remedy reads differently to someone
    // who canceled than to someone who never converted.
    expect(err.message).toBe('this subscription was canceled; choose a plan to restore access');
    expect(err.details).toEqual({ siteId: 'site-1', billingState: 'canceled' });
  });

  it('passes on the last millisecond of the trial', async () => {
    const db = scenario({
      customer: { subscriptionStatus: null, trialEndsAt: new Date(NOW.getTime() + 1) },
    });

    await expect(requireActiveBilling('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
    });
  });

  it('locks out exactly at trialEndsAt', async () => {
    const db = scenario({
      customer: { subscriptionStatus: null, trialEndsAt: new Date(NOW.getTime()) },
    });

    const err = await expectApiAuthError(requireActiveBilling('site-1', opts(db)));
    expect(err.status).toBe(402);
  });

  it('throws 404 before 402 for a missing site', async () => {
    const db = scenario({ customer: EXPIRED });

    const err = await expectApiAuthError(requireActiveBilling('nope', opts(db)));
    expect(err.status).toBe(404);
  });
});

/* ─── requirePro ───────────────────────────────────────────────────────── */

describe('requirePro', () => {
  it('passes a trialing account on a core site — the trial runs at pro level', async () => {
    const db = scenario({ tier: 'core', customer: TRIALING });

    await expect(requirePro('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
      siteTier: 'core',
    });
  });

  it('passes an active subscription on a pro site', async () => {
    const db = scenario({ tier: 'pro', customer: ACTIVE });

    await expect(requirePro('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'active',
      siteTier: 'pro',
    });
  });

  it('throws 403 tier_insufficient for an active subscription on a core site', async () => {
    const db = scenario({ tier: 'core', customer: ACTIVE });

    const err = await expectApiAuthError(requirePro('site-1', opts(db)));
    expect(err.status).toBe(403);
    expect(err.code).toBe('tier_insufficient');
    expect(err.message).toBe(
      'this feature requires the pro tier; upgrade the site to pro to continue',
    );
    expect(err.details).toEqual({ siteId: 'site-1', tier: 'pro', siteTier: 'core' });
  });

  it('throws 402, not 403, for an expired account on a core site', async () => {
    const db = scenario({ tier: 'core', customer: EXPIRED });

    // Billing lockout wins: an expired account can't change its tier until
    // it converts, so 403 would be an instruction it can't follow.
    const err = await expectApiAuthError(requirePro('site-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.code).toBe('trial_expired');
  });

  it('throws 402 for a canceled account on a pro site', async () => {
    const db = scenario({ tier: 'pro', customer: CANCELED });

    const err = await expectApiAuthError(requirePro('site-1', opts(db)));
    expect(err.status).toBe(402);
  });

  it('passes when the customers doc is missing (pre-T0 account)', async () => {
    const db = scenario({ tier: 'core', customer: null });

    await expect(requirePro('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
    });
  });

  it('throws 404 for a missing site', async () => {
    const db = scenario({ tier: 'pro', customer: ACTIVE });

    const err = await expectApiAuthError(requirePro('nope', opts(db)));
    expect(err.status).toBe(404);
  });
});

/* ─── siteTierOrThrow ──────────────────────────────────────────────────── */

describe('siteTierOrThrow', () => {
  it('returns the stored tier', async () => {
    const db = scenario({ tier: 'core', customer: ACTIVE });

    await expect(siteTierOrThrow('site-1', opts(db))).resolves.toBe('core');
  });

  it('reports the stored tier even while trialing — it is not a pro check', async () => {
    const db = scenario({ tier: 'core', customer: TRIALING });

    await expect(siteTierOrThrow('site-1', opts(db))).resolves.toBe('core');
  });

  it('throws the shared 404 for a missing site', async () => {
    const db = scenario({ tier: 'pro', customer: ACTIVE });

    const err = await expectApiAuthError(siteTierOrThrow('nope', opts(db)));
    expect(err.status).toBe(404);
    expect(err.message).toBe('Site not found');
  });
});

/* ─── trial length wiring ──────────────────────────────────────────────── */

describe('trial length', () => {
  it('a freshly-minted 14-day clock resolves as trialing', async () => {
    const db = scenario({
      customer: {
        subscriptionStatus: null,
        trialEndsAt: daysFromNow(TRIAL_LENGTH_DAYS),
      },
    });

    await expect(requirePro('site-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
    });
  });
});

/* ─── account-scoped gates (wave 0.6) ──────────────────────────────────── */

/**
 * An account's customers doc plus the sites it owns. `sites` is a list of
 * `[siteId, tier, owner?]` so a test can plant a decoy owned by someone else.
 */
function accountScenario(
  customer: Record<string, unknown> | null,
  sites: Array<[string, 'core' | 'pro' | undefined, string?]> = [],
): FakeDb {
  const db = new FakeDb();
  if (customer) db.seed('customers/owner-1', customer);
  for (const [siteId, tier, owner] of sites) {
    db.seed(`sites/${siteId}`, {
      owner: owner ?? 'owner-1',
      ...(tier ? { tier } : {}),
    });
  }
  return db;
}

describe('getAccountBillingSnapshot', () => {
  it('resolves pro when any owned site is pro', async () => {
    const db = accountScenario(ACTIVE, [['site-1', 'core'], ['site-2', 'pro']]);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toEqual({
      uid: 'owner-1',
      billingState: 'active',
      accountTier: 'pro',
    });
  });

  it('resolves core when every owned site is core', async () => {
    const db = accountScenario(ACTIVE, [['site-1', 'core'], ['site-2', 'core']]);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toMatchObject({
      accountTier: 'core',
    });
  });

  it('ignores sites owned by other accounts', async () => {
    const db = accountScenario(ACTIVE, [
      ['site-1', 'core'],
      ['site-other', 'pro', 'owner-2'],
    ]);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toMatchObject({
      accountTier: 'core',
    });
  });

  it('resolves core for an account that owns no sites', async () => {
    const db = accountScenario(ACTIVE);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toMatchObject({
      accountTier: 'core',
    });
  });

  it('reads a site with no explicit tier as pro (legacy beta doc)', async () => {
    const db = accountScenario(ACTIVE, [['site-1', undefined]]);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toMatchObject({
      accountTier: 'pro',
    });
  });

  it('treats a missing customers doc as trialing', async () => {
    const db = accountScenario(null, [['site-1', 'core']]);

    await expect(getAccountBillingSnapshot('owner-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
    });
  });
});

describe('requireActiveAccountBilling', () => {
  it.each([
    ['trialing', TRIALING],
    ['active', ACTIVE],
  ])('passes for %s', async (_label, customer) => {
    const db = accountScenario(customer, [['site-1', 'core']]);

    await expect(
      requireActiveAccountBilling('owner-1', opts(db)),
    ).resolves.toMatchObject({ uid: 'owner-1' });
  });

  it('throws 402 trial_expired with no siteId in the details', async () => {
    const db = accountScenario(EXPIRED, [['site-1', 'pro']]);

    const err = await expectApiAuthError(requireActiveAccountBilling('owner-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.code).toBe('trial_expired');
    expect(err.message).toBe('this free trial has ended; choose a plan to restore access');
    expect(err.details).toEqual({ billingState: 'expired' });
  });

  it('throws 402 for a canceled subscription with the canceled wording', async () => {
    const db = accountScenario(CANCELED, [['site-1', 'pro']]);

    const err = await expectApiAuthError(requireActiveAccountBilling('owner-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.details).toEqual({ billingState: 'canceled' });
    expect(err.message).toBe(
      'this subscription was canceled; choose a plan to restore access',
    );
  });
});

describe('requireProAccount', () => {
  it('passes a trialing account whose sites are all core', async () => {
    const db = accountScenario(TRIALING, [['site-1', 'core']]);

    await expect(requireProAccount('owner-1', opts(db))).resolves.toMatchObject({
      billingState: 'trialing',
      accountTier: 'core',
    });
  });

  it('passes an active account holding at least one pro site', async () => {
    const db = accountScenario(ACTIVE, [['site-1', 'core'], ['site-2', 'pro']]);

    await expect(requireProAccount('owner-1', opts(db))).resolves.toMatchObject({
      accountTier: 'pro',
    });
  });

  it('throws 403 tier_insufficient for an active all-core account', async () => {
    const db = accountScenario(ACTIVE, [['site-1', 'core']]);

    const err = await expectApiAuthError(requireProAccount('owner-1', opts(db)));
    expect(err.status).toBe(403);
    expect(err.code).toBe('tier_insufficient');
    expect(err.details).toEqual({ tier: 'pro', accountTier: 'core' });
  });

  it('reports the lockout before the tier when both would fail', async () => {
    const db = accountScenario(EXPIRED, [['site-1', 'core']]);

    const err = await expectApiAuthError(requireProAccount('owner-1', opts(db)));
    expect(err.status).toBe(402);
    expect(err.code).toBe('trial_expired');
  });
});

/* ─── error rendering ──────────────────────────────────────────────────── */

describe('billingErrorToProblem', () => {
  async function bodyOf(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  it('returns null for a non-billing ApiAuthError', () => {
    expect(billingErrorToProblem(new ApiAuthError(403, 'nope'))).toBeNull();
  });

  it('returns null for a plain Error', () => {
    expect(billingErrorToProblem(new Error('boom'))).toBeNull();
  });

  it('renders 402 trial_expired with the billing state', async () => {
    const db = scenario({ tier: 'pro', customer: EXPIRED });
    const err = await expectApiAuthError(requireActiveBilling('site-1', opts(db)));

    const res = billingErrorToProblem(err)!;
    expect(res.status).toBe(402);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(await bodyOf(res)).toMatchObject({
      status: 402,
      code: 'trial_expired',
      billingState: 'expired',
    });
  });

  it('renders 403 tier_insufficient with the required block from the details', async () => {
    const db = scenario({ tier: 'core', customer: ACTIVE });
    const err = await expectApiAuthError(requirePro('site-1', opts(db)));

    const res = billingErrorToProblem(err)!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({
      code: 'tier_insufficient',
      required: { siteId: 'site-1', tier: 'pro', siteTier: 'core' },
    });
  });

  it('omits the required block for an account-scoped tier failure', async () => {
    const db = accountScenario(ACTIVE, [['site-1', 'core']]);
    const err = await expectApiAuthError(requireProAccount('owner-1', opts(db)));

    const res = billingErrorToProblem(err)!;
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).required).toBeUndefined();
  });

  it('falls back to the caller-supplied siteId when the details carry none', async () => {
    const err = new ApiAuthError(403, 'nope', {
      code: 'tier_insufficient',
      details: {},
    });

    const res = billingErrorToProblem(err, 'site-fallback')!;
    expect(await bodyOf(res)).toMatchObject({
      required: { siteId: 'site-fallback', tier: 'pro', siteTier: 'unknown' },
    });
  });
});

/* ─── control-plane lockout policy ─────────────────────────────────────── */

describe('BILLING_LOCKED_CAPABILITIES', () => {
  it.each([
    Capability.MACHINE_EXEC_COMMAND,
    Capability.MACHINE_CONFIG_WRITE,
    Capability.DEPLOYMENT_MANAGE,
    Capability.DISTRIBUTION_MANAGE,
  ])('locks %s', (capability) => {
    expect(isBillingLockedCapability(capability)).toBe(true);
  });

  it.each([
    // Viewing stays open — the matrix keeps metrics/status/screenshots readable.
    Capability.MACHINE_VIEW,
    // Decommissioning is how a customer reduces their bill.
    Capability.MACHINE_REMOVE,
    Capability.UNINSTALL_TRIGGER,
    // Security + stored-config surfaces; none of them reach a machine.
    Capability.SITE_MEMBER_MANAGE,
    Capability.GLOBAL_SETTINGS_WRITE,
    Capability.PRESET_MANAGE,
    Capability.SITE_LOGS_MANAGE,
  ])('does not lock %s', (capability) => {
    expect(isBillingLockedCapability(capability)).toBe(false);
  });

  it('is exactly the four control-plane capabilities', () => {
    expect([...BILLING_LOCKED_CAPABILITIES].sort()).toEqual([
      'DEPLOYMENT_MANAGE',
      'DISTRIBUTION_MANAGE',
      'MACHINE_CONFIG_WRITE',
      'MACHINE_EXEC_COMMAND',
    ]);
  });
});
