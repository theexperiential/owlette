/** @jest-environment node */

/**
 * Stripe webhook handler tests (billing-system wave 1.3).
 *
 * Fixtures are hand-built minimal objects in the shapes Stripe documents for
 * each event, cast to the SDK types. Building them rather than pasting whole
 * sample payloads keeps each test's inputs legible — every field present is a
 * field the code under test actually reads.
 *
 * `FakeDb` follows the pattern established by `billingGate.test.ts`: a
 * path-keyed store injected through the module's `db` option, so nothing here
 * touches the admin SDK. It models the operations the mirror actually uses —
 * `create()`'s ALREADY_EXISTS failure in particular, which is the whole
 * idempotency guarantee.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

/**
 * Mail transport for the wave-4.3 health alerts. `getResend()` is consulted
 * on every send, so flipping `mockResendConfigured` mid-suite exercises the
 * unconfigured-deployment path without re-mocking the module. Both names are
 * `mock`-prefixed because jest hoists `jest.mock` factories above every other
 * statement and only permits out-of-scope references following that
 * convention.
 */
const mockResendSend = jest.fn();
let mockResendConfigured = true;

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => (mockResendConfigured ? { emails: { send: mockResendSend } } : null),
  FROM_EMAIL: 'owlette <noreply@mail.owlette.app>',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));

import {
  HANDLED_EVENT_TYPES,
  handleStripeEvent,
  normalizeSubscriptionStatus,
  tierForPriceIds,
} from '@/lib/billing/stripeEventHandlers';

/* ─── fake firestore ───────────────────────────────────────────────────── */

type Doc = Record<string, unknown>;

class FakeDb {
  readonly store = new Map<string, Doc>();
  /** Collection path whose `.get()` should reject, to exercise failure paths. */
  failQueryOn: string | null = null;

  collection(path: string): FakeCollection {
    return new FakeCollection(this, path);
  }

  /**
   * No isolation or retries — the production transaction exists to make
   * read-merge-write atomic against concurrent webhook deliveries, and the
   * tests drive one event at a time.
   */
  async runTransaction<T>(
    fn: (tx: {
      get: (ref: FakeDocRef) => Promise<FakeSnapshot>;
      set: (ref: FakeDocRef, data: Doc, opts?: { merge?: boolean }) => void;
      update: (ref: FakeDocRef, data: Doc) => void;
    }) => Promise<T>,
  ): Promise<T> {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => {
        void ref.set(data, opts);
      },
      update: (ref, data) => {
        void ref.update(data);
      },
    });
  }

  seed(path: string, data: Doc): this {
    this.store.set(path, { ...data });
    return this;
  }

  read(path: string): Doc | undefined {
    const data = this.store.get(path);
    return data ? { ...data } : undefined;
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

interface FakeSnapshot {
  exists: boolean;
  id: string;
  data: () => Doc | undefined;
}

/** True for a plain `{}` map — the only shape Firestore merges recursively. */
function isPlainMap(value: unknown): value is Doc {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Recursive merge with Firestore's semantics: maps merge, everything else replaces. */
function deepMerge(prev: Doc, next: Doc): Doc {
  const out: Doc = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    const existing = out[key];
    out[key] = isPlainMap(value) && isPlainMap(existing) ? deepMerge(existing, value) : value;
  }
  return out;
}

class FakeDocRef {
  constructor(readonly db: FakeDb, readonly path: string) {}

  get id(): string {
    return this.path.split('/').pop() as string;
  }

  async get(): Promise<FakeSnapshot> {
    const data = this.db.store.get(this.path);
    return { exists: data !== undefined, id: this.id, data: () => (data ? { ...data } : undefined) };
  }

  /**
   * Firestore's `set(..., { merge: true })` merges *recursively* into nested
   * maps — that is what lets one health-alert kind be stamped without
   * clobbering its siblings, exactly as `trialEmails` markers rely on. A flat
   * spread would silently pass a test the real database would fail.
   */
  async set(data: Doc, opts?: { merge?: boolean }): Promise<void> {
    const prev = opts?.merge ? this.db.store.get(this.path) ?? {} : {};
    this.db.store.set(this.path, opts?.merge ? deepMerge(prev, data) : { ...data });
  }

  async update(data: Doc): Promise<void> {
    const prev = this.db.store.get(this.path);
    if (prev === undefined) throw new Error(`NOT_FOUND: ${this.path}`);
    this.db.store.set(this.path, { ...prev, ...data });
  }

  /** Mirrors Firestore: rejects with gRPC code 6 when the doc already exists. */
  async create(data: Doc): Promise<void> {
    if (this.db.store.has(this.path)) {
      throw Object.assign(new Error(`6 ALREADY_EXISTS: entity already exists: ${this.path}`), {
        code: 6,
      });
    }
    this.db.store.set(this.path, { ...data });
  }

  async delete(): Promise<void> {
    this.db.store.delete(this.path);
  }

  collection(sub: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${sub}`);
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly max: number | null = null,
  ) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  where(field: string, _op: string, value: unknown): FakeCollection {
    return new FakeCollection(this.db, this.path, [...this.filters, [field, value]], this.max);
  }

  limit(n: number): FakeCollection {
    return new FakeCollection(this.db, this.path, this.filters, n);
  }

  async get(): Promise<{ docs: Array<FakeSnapshot & { ref: FakeDocRef }> }> {
    if (this.db.failQueryOn === this.path) {
      throw new Error(`simulated firestore failure on ${this.path}`);
    }

    const prefix = `${this.path}/`;
    const docs = [...this.db.store.entries()]
      // direct children only — a subcollection path contains a further slash
      .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .filter(([, data]) => this.filters.every(([field, value]) => data[field] === value))
      .map(([key, data]) => ({
        exists: true,
        id: key.slice(prefix.length),
        data: () => ({ ...data }),
        ref: new FakeDocRef(this.db, key),
      }));

    return { docs: this.max === null ? docs : docs.slice(0, this.max) };
  }
}

/* ─── fixtures ─────────────────────────────────────────────────────────── */

const NOW = new Date('2026-08-01T12:00:00.000Z');
const PERIOD_END = 1_788_000_000; // epoch seconds
const UID = 'owner-1';
const STRIPE_CUSTOMER = 'cus_test123';

/** Health-alert audiences: the account owner and the ops address. */
const OWNER_EMAIL = 'owner@example.com';
const OPS_EMAIL = 'ops@owlette.test';

const PRICE_CORE = 'price_core_machine_test';
const PRICE_PRO = 'price_pro_machine_test';
const PRICE_OVERAGE = 'price_pro_storage_overage_test';

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter}`;
}

function subscriptionEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  opts: {
    id?: string;
    status?: string;
    priceIds?: string[];
    customer?: string | { id: string; metadata?: Record<string, string> };
    metadata?: Record<string, string>;
    subscriptionId?: string;
    periodEnd?: number | null;
  } = {},
): Stripe.Event {
  const {
    id = nextEventId(),
    status = 'active',
    priceIds = [PRICE_PRO],
    customer = STRIPE_CUSTOMER,
    metadata,
    subscriptionId = 'sub_test123',
    periodEnd = PERIOD_END,
  } = opts;

  return {
    id,
    object: 'event',
    api_version: '2025-11-17.clover',
    created: 1_785_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        customer,
        status,
        ...(metadata ? { metadata } : {}),
        items: {
          object: 'list',
          has_more: false,
          url: '/v1/subscription_items',
          data: priceIds.map((priceId, index) => ({
            id: `si_${index}`,
            object: 'subscription_item',
            price: { id: priceId, object: 'price' },
            ...(periodEnd === null ? {} : { current_period_end: periodEnd }),
          })),
        },
      },
    },
  } as unknown as Stripe.Event;
}

function invoiceEvent(
  type: 'invoice.created' | 'invoice.finalized' | 'invoice.paid' | 'invoice.payment_failed',
  opts: {
    id?: string;
    invoiceId?: string;
    status?: string;
    subscriptionId?: string | null;
    customer?: string;
    amountDue?: number;
  } = {},
): Stripe.Event {
  const {
    id = nextEventId(),
    invoiceId = 'in_test123',
    status = 'open',
    subscriptionId = 'sub_test123',
    customer = STRIPE_CUSTOMER,
    amountDue = 15_000,
  } = opts;

  return {
    id,
    object: 'event',
    api_version: '2025-11-17.clover',
    created: 1_785_000_100,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        customer,
        number: 'OWL-0001',
        status,
        currency: 'usd',
        amount_due: amountDue,
        amount_paid: status === 'paid' ? amountDue : 0,
        amount_remaining: status === 'paid' ? 0 : amountDue,
        subtotal: amountDue,
        total: amountDue,
        billing_reason: 'subscription_cycle',
        collection_method: 'charge_automatically',
        attempt_count: type === 'invoice.payment_failed' ? 1 : 0,
        created: 1_785_000_050,
        period_start: 1_784_000_000,
        period_end: PERIOD_END,
        due_date: null,
        status_transitions: {
          finalized_at: 1_785_000_060,
          marked_uncollectible_at: null,
          paid_at: status === 'paid' ? 1_785_000_070 : null,
          voided_at: null,
        },
        hosted_invoice_url: 'https://invoice.stripe.com/i/test',
        invoice_pdf: 'https://invoice.stripe.com/i/test.pdf',
        parent: subscriptionId
          ? {
              type: 'subscription_details',
              quote_details: null,
              subscription_details: { subscription: subscriptionId, metadata: null },
            }
          : null,
      },
    },
  } as unknown as Stripe.Event;
}

function customerUpdatedEvent(
  opts: { id?: string; defaultPaymentMethod?: string | null; metadata?: Record<string, string> } = {},
): Stripe.Event {
  const { id = nextEventId(), defaultPaymentMethod = 'pm_test123', metadata } = opts;

  return {
    id,
    object: 'event',
    api_version: '2025-11-17.clover',
    created: 1_785_000_200,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: 'customer.updated',
    data: {
      object: {
        id: STRIPE_CUSTOMER,
        object: 'customer',
        email: 'owner@example.com',
        ...(metadata ? { metadata } : {}),
        invoice_settings: { default_payment_method: defaultPaymentMethod },
      },
    },
  } as unknown as Stripe.Event;
}

/** A customer doc + its sites. `sites` maps site id → stored `tier` value. */
function scenario(
  opts: {
    customer?: Doc | null;
    sites?: Record<string, string | undefined>;
  } = {},
): FakeDb {
  const {
    customer = {
      stripeCustomerId: STRIPE_CUSTOMER,
      subscriptionId: null,
      subscriptionStatus: null,
      subscriptionTier: null,
      trialEndsAt: new Date('2026-08-10T00:00:00.000Z'),
      billingState: 'trialing',
      currentPeriodEnd: null,
      defaultPaymentMethod: null,
      taxId: null,
    },
    sites = {},
  } = opts;

  const db = new FakeDb();
  if (customer) db.seed(`customers/${UID}`, customer);
  for (const [siteId, tier] of Object.entries(sites)) {
    db.seed(`sites/${siteId}`, { owner: UID, ...(tier === undefined ? {} : { tier }) });
  }
  return db;
}

function run(db: FakeDb, event: Stripe.Event) {
  return handleStripeEvent(event, { db: db.asFirestore(), now: NOW });
}

/** Messages the mocked Resend client was handed, oldest first. */
function sentMessages(): Array<{ to: string[]; subject: string; html: string }> {
  return mockResendSend.mock.calls.map(
    ([message]) => message as { to: string[]; subject: string; html: string },
  );
}

/** Flat list of every address mailed this test. */
function sentTo(): string[] {
  return sentMessages().flatMap((m) => m.to);
}

/* ─── tests ────────────────────────────────────────────────────────────── */

describe('stripe event handlers', () => {
  const originalEnv = { ...process.env };
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.STRIPE_PRICE_CORE_MACHINE = PRICE_CORE;
    process.env.STRIPE_PRICE_PRO_MACHINE = PRICE_PRO;
    process.env.STRIPE_PRICE_PRO_STORAGE_OVERAGE = PRICE_OVERAGE;
    // Health alerts (4.3): a configured transport and ops address by default,
    // so every event that raises an alert exercises the real send path.
    process.env.ADMIN_EMAIL_DEV = OPS_EMAIL;
    mockResendConfigured = true;
    mockResendSend.mockResolvedValue({ data: { id: 'email_test' }, error: null });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  /* --- status normalisation ------------------------------------------- */

  describe('normalizeSubscriptionStatus', () => {
    const ctx = { eventId: 'evt_x', type: 'customer.subscription.updated' };

    it.each([
      ['active', 'active'],
      ['past_due', 'past_due'],
      ['canceled', 'canceled'],
      ['incomplete_expired', 'canceled'],
      ['incomplete', 'incomplete'],
    ])('maps %s → %s without warning', (stripe, expected) => {
      expect(normalizeSubscriptionStatus(stripe, ctx)).toBe(expected);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['trialing', 'active'],
      ['unpaid', 'past_due'],
      ['paused', 'past_due'],
    ])('maps %s → %s with a warning', (stripe, expected) => {
      expect(normalizeSubscriptionStatus(stripe, ctx)).toBe(expected);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('maps an unrecognised status to incomplete — never to a paid state', () => {
      expect(normalizeSubscriptionStatus('some_future_status', ctx)).toBe('incomplete');
      expect(normalizeSubscriptionStatus(null, ctx)).toBe('incomplete');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  /* --- tier mapping ---------------------------------------------------- */

  describe('tierForPriceIds', () => {
    it('maps the core machine price to core', () => {
      expect(tierForPriceIds([PRICE_CORE])).toBe('core');
    });

    it('maps the pro machine price to pro', () => {
      expect(tierForPriceIds([PRICE_PRO])).toBe('pro');
    });

    it('maps the storage overage price to pro', () => {
      expect(tierForPriceIds([PRICE_OVERAGE])).toBe('pro');
    });

    it('resolves a multi-item pro subscription to pro', () => {
      expect(tierForPriceIds([PRICE_PRO, PRICE_OVERAGE])).toBe('pro');
    });

    it('returns null for an unconfigured price id', () => {
      expect(tierForPriceIds(['price_something_else'])).toBeNull();
      expect(tierForPriceIds([])).toBeNull();
    });

    it('returns null rather than matching an unset env var', () => {
      delete process.env.STRIPE_PRICE_CORE_MACHINE;
      expect(tierForPriceIds([''])).toBeNull();
    });
  });

  /* --- subscription created -------------------------------------------- */

  describe('customer.subscription.created', () => {
    it('updates the customer doc and stamps every site whose tier differs', async () => {
      const db = scenario({
        sites: { 'site-core': 'core', 'site-pro': 'pro', 'site-legacy': undefined },
      });

      const result = await run(db, subscriptionEvent('customer.subscription.created'));

      expect(result.outcome).toBe('processed');
      expect(result.uid).toBe(UID);

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionId: 'sub_test123',
        subscriptionStatus: 'active',
        subscriptionTier: 'pro',
        billingState: 'active',
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        stripeCustomerId: STRIPE_CUSTOMER,
      });

      // 'core' differs and the legacy doc has no stored tier at all — both are
      // rewritten. 'pro' already matches, so it is left untouched.
      expect(db.read('sites/site-core')).toMatchObject({
        tier: 'pro',
        tierUpgradedAt: '__SERVER_TS__',
      });
      expect(db.read('sites/site-legacy')).toMatchObject({
        tier: 'pro',
        tierUpgradedAt: '__SERVER_TS__',
      });
      expect(db.read('sites/site-pro')).toEqual({ owner: UID, tier: 'pro' });
    });

    it('stamps a core subscription onto the account’s sites', async () => {
      const db = scenario({ sites: { 'site-a': 'pro' } });

      await run(
        db,
        subscriptionEvent('customer.subscription.created', { priceIds: [PRICE_CORE] }),
      );

      expect(db.read(`customers/${UID}`)).toMatchObject({ subscriptionTier: 'core' });
      expect(db.read('sites/site-a')).toMatchObject({ tier: 'core' });
    });

    it('leaves subscriptionTier alone when no configured price matches', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionTier: 'pro',
      });

      await run(
        db,
        subscriptionEvent('customer.subscription.created', { priceIds: ['price_unknown'] }),
      );

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionTier: 'pro',
        subscriptionStatus: 'active',
      });
      // No resolvable tier means nothing to stamp.
      expect(db.read('sites/site-a')).toEqual({ owner: UID, tier: 'core' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no configured price id'),
      );
    });

    it('falls back to the item period end when the legacy field is absent', async () => {
      const db = scenario();
      await run(db, subscriptionEvent('customer.subscription.created'));
      expect(db.read(`customers/${UID}`)?.currentPeriodEnd).toEqual(
        new Date(PERIOD_END * 1000),
      );
    });

    it('writes a null period end when no item carries one', async () => {
      const db = scenario();
      await run(db, subscriptionEvent('customer.subscription.created', { periodEnd: null }));
      expect(db.read(`customers/${UID}`)?.currentPeriodEnd).toBeNull();
    });
  });

  /* --- subscription updated -------------------------------------------- */

  describe('customer.subscription.updated', () => {
    it('mirrors a status change to past_due while keeping the account active', async () => {
      const db = scenario({ sites: { 'site-a': 'pro' } });
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionId: 'sub_test123',
        subscriptionStatus: 'active',
        subscriptionTier: 'pro',
        billingState: 'active',
      });

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'past_due' }));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'past_due',
        // past_due keeps access — Stripe dunning owns the recovery window.
        billingState: 'active',
      });
    });

    it('does not stamp site tiers for a non-entitling status', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'incomplete' }));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'incomplete',
        // incomplete falls through to the trial clock, which is still running.
        billingState: 'trialing',
      });
      expect(db.read('sites/site-a')).toEqual({ owner: UID, tier: 'core' });
    });

    it('treats a stripe-side trialing subscription as active, with a warning', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'trialing' }));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'active',
        billingState: 'active',
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('app-managed'));
    });
  });

  /* --- subscription deleted -------------------------------------------- */

  describe('customer.subscription.deleted', () => {
    it('cancels the subscription and leaves site tiers untouched', async () => {
      const db = scenario({ sites: { 'site-a': 'pro', 'site-b': 'core' } });
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionId: 'sub_test123',
        subscriptionStatus: 'active',
        subscriptionTier: 'pro',
        billingState: 'active',
      });

      await run(db, subscriptionEvent('customer.subscription.deleted', { status: 'canceled' }));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'canceled',
        billingState: 'canceled',
        // the record of what they paid for survives the cancellation
        subscriptionTier: 'pro',
      });
      expect(db.read('sites/site-a')).toEqual({ owner: UID, tier: 'pro' });
      expect(db.read('sites/site-b')).toEqual({ owner: UID, tier: 'core' });
    });

    it('cancels even when stripe still reports the subscription as active', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });

      await run(db, subscriptionEvent('customer.subscription.deleted', { status: 'active' }));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'canceled',
        billingState: 'canceled',
      });
      expect(db.read('sites/site-a')).toEqual({ owner: UID, tier: 'core' });
    });
  });

  /* --- invoices --------------------------------------------------------- */

  describe('invoice events', () => {
    it('mirrors a failed renewal and marks an active subscription past_due', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionId: 'sub_test123',
        subscriptionStatus: 'active',
        billingState: 'active',
      });

      const result = await run(db, invoiceEvent('invoice.payment_failed'));

      expect(result.outcome).toBe('processed');
      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'past_due',
        billingState: 'active',
      });
      expect(db.read(`billing/${UID}/invoices/in_test123`)).toMatchObject({
        id: 'in_test123',
        number: 'OWL-0001',
        status: 'open',
        currency: 'usd',
        amountDue: 15_000,
        amountRemaining: 15_000,
        attemptCount: 1,
        subscriptionId: 'sub_test123',
        stripeCustomerId: STRIPE_CUSTOMER,
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/test',
        invoicePdf: 'https://invoice.stripe.com/i/test.pdf',
        periodEnd: new Date(PERIOD_END * 1000),
        mirroredAt: '__SERVER_TS__',
      });
    });

    it('does not promote an incomplete subscription to past_due on a first-invoice failure', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionStatus: 'incomplete',
        billingState: 'trialing',
      });

      await run(db, invoiceEvent('invoice.payment_failed'));

      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'incomplete',
        billingState: 'trialing',
      });
      expect(db.has(`billing/${UID}/invoices/in_test123`)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('renewal failed'));
    });

    it.each(['invoice.created', 'invoice.finalized', 'invoice.paid'] as const)(
      '%s mirrors the invoice without touching subscription status',
      async (type) => {
        const db = scenario();
        db.seed(`customers/${UID}`, {
          ...db.read(`customers/${UID}`),
          subscriptionStatus: 'active',
          billingState: 'active',
        });

        await run(db, invoiceEvent(type, { status: type === 'invoice.paid' ? 'paid' : 'open' }));

        expect(db.read(`customers/${UID}`)).toMatchObject({ subscriptionStatus: 'active' });
        expect(db.has(`billing/${UID}/invoices/in_test123`)).toBe(true);
      },
    );

    it('refines the same invoice doc across the created → paid lifecycle', async () => {
      const db = scenario();

      await run(db, invoiceEvent('invoice.created', { status: 'draft' }));
      await run(db, invoiceEvent('invoice.paid', { status: 'paid' }));

      const mirrored = db.read(`billing/${UID}/invoices/in_test123`);
      expect(mirrored).toMatchObject({
        status: 'paid',
        amountPaid: 15_000,
        amountRemaining: 0,
        paidAt: new Date(1_785_000_070 * 1000),
      });
    });

    it('mirrors a one-off invoice with no subscription without changing status', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionStatus: 'active',
      });

      await run(db, invoiceEvent('invoice.payment_failed', { subscriptionId: null }));

      expect(db.read(`customers/${UID}`)).toMatchObject({ subscriptionStatus: 'active' });
      expect(db.read(`billing/${UID}/invoices/in_test123`)).toMatchObject({
        subscriptionId: null,
      });
    });
  });

  /* --- customer.updated -------------------------------------------------- */

  describe('customer.updated', () => {
    it('mirrors the default payment method and recomputes billing state', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionStatus: 'active',
      });

      const result = await run(db, customerUpdatedEvent());

      expect(result.outcome).toBe('processed');
      expect(db.read(`customers/${UID}`)).toMatchObject({
        defaultPaymentMethod: 'pm_test123',
        stripeCustomerId: STRIPE_CUSTOMER,
        billingState: 'active',
      });
    });

    it('clears the default payment method when stripe reports none', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        defaultPaymentMethod: 'pm_old',
      });

      await run(db, customerUpdatedEvent({ defaultPaymentMethod: null }));

      expect(db.read(`customers/${UID}`)?.defaultPaymentMethod).toBeNull();
    });

    it('leaves taxId untouched', async () => {
      const db = scenario();
      db.seed(`customers/${UID}`, { ...db.read(`customers/${UID}`), taxId: 'VAT-123' });

      await run(db, customerUpdatedEvent());

      expect(db.read(`customers/${UID}`)?.taxId).toBe('VAT-123');
    });
  });

  /* --- subscription health alerts (wave 4.3) ----------------------------- */

  describe('subscription health alerts', () => {
    /** A converted account with a deliverable owner address. */
    function subscribed(overrides: Doc = {}): FakeDb {
      const db = scenario({ sites: { 'site-a': 'pro' } });
      db.seed(`users/${UID}`, { email: OWNER_EMAIL });
      db.seed(`customers/${UID}`, {
        ...db.read(`customers/${UID}`),
        subscriptionId: 'sub_test123',
        subscriptionStatus: 'active',
        subscriptionTier: 'pro',
        billingState: 'active',
        ...overrides,
      });
      return db;
    }

    it('mails both audiences when a subscription is deleted', async () => {
      const db = subscribed();
      const event = subscriptionEvent('customer.subscription.deleted');

      const result = await run(db, event);

      expect(result.outcome).toBe('processed');
      expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);

      const [owner, ops] = sentMessages();
      expect(owner.subject).toBe('your owlette subscription was canceled');
      expect(owner.html).toContain('billing=choose-plan');
      // Customer copy stays lowercase and never leaks internal identifiers.
      expect(owner.html).not.toContain(UID);
      expect(owner.html).not.toContain(event.id);

      expect(ops.subject).toBe(`[TEST] billing: subscription canceled — ${UID}`);
      expect(ops.html).toContain(UID);
      expect(ops.html).toContain(event.id);
      expect(ops.html).toContain('customer.subscription.deleted');
      // State at the moment of the alert — the cancel write has already landed.
      expect(ops.html).toContain('canceled');

      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({
        subscription_canceled: NOW,
      });
    });

    it('mails both audiences when a subscription invoice payment fails', async () => {
      const db = subscribed();

      await run(db, invoiceEvent('invoice.payment_failed'));

      expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);
      const [owner, ops] = sentMessages();
      expect(owner.subject).toBe("we couldn't process your owlette payment");
      expect(ops.subject).toContain('billing: payment failed');
      expect(ops.html).toContain('in_test123');

      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({ payment_failed: NOW });
    });

    it('mails both audiences on the transition into past_due', async () => {
      const db = subscribed();

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'past_due' }));

      expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);
      const [owner, ops] = sentMessages();
      expect(owner.subject).toBe('your owlette account is past due');
      expect(ops.subject).toContain('billing: account past due');

      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({ past_due: NOW });
    });

    it('stays silent for an update that merely carries past_due', async () => {
      // Stripe re-sends the same status throughout dunning; only the edge is news.
      const db = subscribed({ subscriptionStatus: 'past_due' });

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'past_due' }));

      expect(mockResendSend).not.toHaveBeenCalled();
      expect(db.read(`customers/${UID}`)?.healthAlerts).toBeUndefined();
    });

    it('treats a first-ever past_due as a transition', async () => {
      const db = subscribed({ subscriptionStatus: null, billingState: 'trialing' });

      await run(db, subscriptionEvent('customer.subscription.updated', { status: 'past_due' }));

      expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);
    });

    it('suppresses a repeat of the same kind inside the 24h cooldown', async () => {
      const db = subscribed({
        healthAlerts: { subscription_canceled: new Date(NOW.getTime() - 23 * 60 * 60 * 1000) },
      });

      await run(db, subscriptionEvent('customer.subscription.deleted'));

      expect(mockResendSend).not.toHaveBeenCalled();
      // The marker is left at its original instant — a suppressed alert must
      // not extend its own cooldown.
      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({
        subscription_canceled: new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
      });
    });

    it('sends again once the cooldown has elapsed', async () => {
      const db = subscribed({
        healthAlerts: { subscription_canceled: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) },
      });

      await run(db, subscriptionEvent('customer.subscription.deleted'));

      expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);
      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({
        subscription_canceled: NOW,
      });
    });

    it('stamps one kind without clobbering another kind’s marker', async () => {
      const previous = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
      const db = subscribed({ healthAlerts: { payment_failed: previous } });

      await run(db, subscriptionEvent('customer.subscription.deleted'));

      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({
        payment_failed: previous,
        subscription_canceled: NOW,
      });
    });

    it('processes the event normally when every send throws', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockResendSend.mockRejectedValue(new Error('resend is down'));
      const db = subscribed();

      const result = await run(db, subscriptionEvent('customer.subscription.deleted'));

      // The webhook still succeeds, and the mirror write still landed.
      expect(result.outcome).toBe('processed');
      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'canceled',
        billingState: 'canceled',
      });
      // Nothing was stamped, so the next event retries rather than burning it.
      expect(db.read(`customers/${UID}`)?.healthAlerts).toBeUndefined();
      errorSpy.mockRestore();
    });

    it('still mails ops when the account has no deliverable owner address', async () => {
      const db = subscribed();
      db.seed(`users/${UID}`, { email: OWNER_EMAIL, deletedAt: 1_785_000_000 });

      await run(db, subscriptionEvent('customer.subscription.deleted'));

      expect(sentTo()).toEqual([OPS_EMAIL]);
      expect(db.read(`customers/${UID}`)?.healthAlerts).toEqual({
        subscription_canceled: NOW,
      });
    });

    it('skips silently when resend is unconfigured', async () => {
      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
      mockResendConfigured = false;
      const db = subscribed();

      const result = await run(db, subscriptionEvent('customer.subscription.deleted'));

      expect(result.outcome).toBe('processed');
      expect(mockResendSend).not.toHaveBeenCalled();
      expect(db.read(`customers/${UID}`)?.healthAlerts).toBeUndefined();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('resend not configured'),
      );
      debugSpy.mockRestore();
    });

    it('raises nothing for a one-off invoice with no subscription', async () => {
      const db = subscribed();

      await run(db, invoiceEvent('invoice.payment_failed', { subscriptionId: null }));

      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it.each([
      'customer.subscription.created',
      'customer.subscription.updated',
    ] as const)('raises nothing for a healthy %s', async (type) => {
      const db = subscribed();

      await run(db, subscriptionEvent(type, { status: 'active' }));

      expect(mockResendSend).not.toHaveBeenCalled();
    });
  });

  /* --- uid resolution ---------------------------------------------------- */

  describe('uid resolution', () => {
    it('prefers metadata.uid over the stripeCustomerId lookup', async () => {
      // No customers doc carries this stripe id, so only metadata can resolve it.
      const db = new FakeDb();
      db.seed(`customers/${UID}`, { stripeCustomerId: 'cus_other', trialEndsAt: null });

      const result = await run(
        db,
        subscriptionEvent('customer.subscription.created', { metadata: { uid: UID } }),
      );

      expect(result.uid).toBe(UID);
      expect(db.read(`customers/${UID}`)).toMatchObject({ subscriptionStatus: 'active' });
    });

    it('reads metadata.uid off an expanded customer object', async () => {
      const db = new FakeDb();
      db.seed(`customers/${UID}`, { stripeCustomerId: 'cus_other', trialEndsAt: null });

      const result = await run(
        db,
        subscriptionEvent('customer.subscription.created', {
          customer: { id: STRIPE_CUSTOMER, metadata: { uid: UID } },
        }),
      );

      expect(result.uid).toBe(UID);
    });

    it('falls back to querying customers by stripeCustomerId', async () => {
      const db = scenario();
      const result = await run(db, subscriptionEvent('customer.subscription.created'));
      expect(result.uid).toBe(UID);
    });

    it('acknowledges an unknown customer with a warning and no writes', async () => {
      const db = new FakeDb(); // no customers doc at all

      const result = await run(db, subscriptionEvent('customer.subscription.created'));

      expect(result.outcome).toBe('unknown_customer');
      expect(result.uid).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`no owlette account for stripe customer ${STRIPE_CUSTOMER}`),
      );
      // ledger only — nothing else was written
      expect([...db.store.keys()]).toEqual([`stripe_events/${result.eventId}`]);
      expect(db.read(`stripe_events/${result.eventId}`)).toMatchObject({
        outcome: 'unknown_customer',
      });
    });

    it('creates a missing customers doc when metadata names the account', async () => {
      const db = new FakeDb();

      const result = await run(
        db,
        subscriptionEvent('customer.subscription.created', { metadata: { uid: UID } }),
      );

      expect(result.outcome).toBe('processed');
      expect(db.read(`customers/${UID}`)).toMatchObject({
        subscriptionStatus: 'active',
        billingState: 'active',
      });
    });
  });

  /* --- idempotency -------------------------------------------------------- */

  describe('idempotency', () => {
    it('short-circuits a replayed event id', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });
      const event = subscriptionEvent('customer.subscription.created');

      const first = await run(db, event);
      expect(first.outcome).toBe('processed');
      expect(db.read('sites/site-a')).toMatchObject({ tier: 'pro' });

      // Rewind the world; a replay must not touch it again.
      db.seed('sites/site-a', { owner: UID, tier: 'core' });
      const replay = await run(db, event);

      expect(replay.outcome).toBe('duplicate');
      expect(db.read('sites/site-a')).toEqual({ owner: UID, tier: 'core' });
    });

    it('records the outcome on the ledger doc', async () => {
      const db = scenario();
      const result = await run(db, subscriptionEvent('customer.subscription.created'));

      expect(db.read(`billing/${UID}/stripe_events/${result.eventId}`)).toMatchObject({
        eventId: result.eventId,
        type: 'customer.subscription.created',
        outcome: 'processed',
        processedAt: '__SERVER_TS__',
      });
    });

    it('releases the claim when handling throws, so stripe can retry', async () => {
      const db = scenario({ sites: { 'site-a': 'core' } });
      db.failQueryOn = 'sites';

      const event = subscriptionEvent('customer.subscription.created');
      await expect(run(db, event)).rejects.toThrow('simulated firestore failure');

      expect(db.has(`billing/${UID}/stripe_events/${event.id}`)).toBe(false);

      // With the fault cleared, the retry runs the event for real.
      db.failQueryOn = null;
      const retry = await run(db, event);
      expect(retry.outcome).toBe('processed');
      expect(db.read('sites/site-a')).toMatchObject({ tier: 'pro' });
    });
  });

  /* --- unhandled types ----------------------------------------------------- */

  describe('unhandled event types', () => {
    it('ignores a type we do not subscribe to, without writing a ledger entry', async () => {
      const db = scenario();
      const event = { ...subscriptionEvent('customer.subscription.created') } as Stripe.Event;
      (event as { type: string }).type = 'charge.succeeded';

      const result = await run(db, event);

      expect(result.outcome).toBe('ignored');
      expect(result.uid).toBeNull();
      expect(db.has(`stripe_events/${event.id}`)).toBe(false);
    });

    it('declares exactly the eight types wave 1.3 handles', () => {
      expect([...HANDLED_EVENT_TYPES].sort()).toEqual([
        'customer.subscription.created',
        'customer.subscription.deleted',
        'customer.subscription.updated',
        'customer.updated',
        'invoice.created',
        'invoice.finalized',
        'invoice.paid',
        'invoice.payment_failed',
      ]);
    });
  });
});
