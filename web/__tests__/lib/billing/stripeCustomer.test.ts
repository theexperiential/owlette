/** @jest-environment node */

/**
 * Stripe customer linking (billing-system wave 1.2).
 *
 * Covers `linkStripeCustomer()` plus the bootstrap wiring that calls it. The
 * Stripe SDK is mocked at the `@/lib/stripe.server` boundary rather than at
 * the `stripe` package, so these tests pin OUR contract (metadata.uid, the
 * email-collision rule, the never-throw posture) and not the SDK's internals.
 *
 * The four things a regression would break silently:
 *   - a created customer without `metadata.uid` — the webhook's primary uid
 *     resolution stops working and every event takes the fallback query,
 *   - a duplicate customer per email — the account is billed twice,
 *   - a thrown error on the signup path — a new user gets an error toast and
 *     the retry short-circuits on `already_exists`, never repairing anything,
 *   - a Stripe call while unconfigured — every signup pays a network timeout
 *     for the whole pre-go-live window.
 */

const mockGetStripeOrNull = jest.fn();
const mockStripeMode = jest.fn(() => 'test');

jest.mock('@/lib/stripe.server', () => ({
  getStripeOrNull: () => mockGetStripeOrNull(),
  stripeMode: () => mockStripeMode(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(() => {
    throw new Error('getAdminDb() must not be reached — inject `db`');
  }),
}));

import type { Firestore } from 'firebase-admin/firestore';
import { linkStripeCustomer } from '@/lib/billing/stripeCustomer.server';
import { bootstrapUser } from '@/lib/actions/bootstrapUser.server';

/* ─── fake firestore ───────────────────────────────────────────────────── */

class FakeDb {
  readonly docs = new Map<string, Record<string, unknown>>();
  /** Paths whose `update()` should reject, simulating a write failure. */
  readonly failingUpdates = new Set<string>();

  collection(path: string) {
    return {
      doc: (id: string) => {
        const docPath = `${path}/${id}`;
        return {
          get: async () => {
            const data = this.docs.get(docPath);
            return {
              exists: data !== undefined,
              data: () => (data ? { ...data } : undefined),
            };
          },
          set: async (data: Record<string, unknown>) => {
            this.docs.set(docPath, { ...data });
          },
          update: async (patch: Record<string, unknown>) => {
            if (this.failingUpdates.has(docPath)) {
              throw new Error('simulated firestore write failure');
            }
            const current = this.docs.get(docPath);
            // Real Firestore `update()` rejects on a missing doc rather than
            // creating a partial one. The link path depends on that.
            if (current === undefined) {
              throw new Error('NOT_FOUND: no document to update');
            }
            this.docs.set(docPath, { ...current, ...patch });
          },
        };
      },
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

/* ─── fake stripe ──────────────────────────────────────────────────────── */

interface FakeCustomer {
  id: string;
  email: string;
  metadata: Record<string, string>;
}

function fakeStripe(seed: FakeCustomer[] = []) {
  const customers = [...seed];
  let nextId = 1;

  const list = jest.fn(async (params: { email: string; limit?: number }) => ({
    data: customers.filter((c) => c.email === params.email).slice(0, params.limit ?? 10),
  }));

  const create = jest.fn(
    async (params: { email: string; metadata?: Record<string, string> }) => {
      const customer: FakeCustomer = {
        id: `cus_new_${nextId++}`,
        email: params.email,
        metadata: { ...(params.metadata ?? {}) },
      };
      customers.push(customer);
      return customer;
    },
  );

  const update = jest.fn(
    async (id: string, params: { metadata?: Record<string, string> }) => {
      const customer = customers.find((c) => c.id === id);
      if (!customer) throw new Error(`no such customer: ${id}`);
      customer.metadata = { ...customer.metadata, ...(params.metadata ?? {}) };
      return customer;
    },
  );

  return {
    client: { customers: { list, create, update } },
    calls: { list, create, update },
    customers,
  };
}

/** A minted (unlinked) customers doc, as `newCustomerDoc()` writes it. */
function seededCustomerDoc(): Record<string, unknown> {
  return {
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    subscriptionTier: null,
    trialEndsAt: null,
    billingState: 'trialing',
    currentPeriodEnd: null,
    defaultPaymentMethod: null,
    taxId: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStripeMode.mockReturnValue('test');
});

/* ─── linkStripeCustomer ───────────────────────────────────────────────── */

describe('linkStripeCustomer', () => {
  it('creates a customer carrying metadata.uid and writes the id back', async () => {
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'new@example.com',
    });

    expect(id).toBe('cus_new_1');
    expect(stripe.calls.create).toHaveBeenCalledTimes(1);
    // The uid contract: the webhook resolves an account from this metadata.
    expect(stripe.calls.create).toHaveBeenCalledWith(
      { email: 'new@example.com', metadata: { uid: 'uid-1' } },
      expect.objectContaining({ idempotencyKey: 'owlette-customer-uid-1' }),
    );
    expect(db.docs.get('customers/uid-1')).toMatchObject({
      stripeCustomerId: 'cus_new_1',
      // The rest of the doc survives — this is an update, not a set.
      billingState: 'trialing',
      trialEndsAt: null,
    });
  });

  it('bounds the signup path with a tight timeout and no retries', async () => {
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'new@example.com',
      signupPath: true,
    });

    // A user is waiting on this: one round trip, capped well under the SDK's
    // 80-second default.
    expect(stripe.calls.list).toHaveBeenCalledWith(
      { email: 'new@example.com', limit: 1 },
      { timeout: 4_000, maxNetworkRetries: 0 },
    );
    expect(stripe.calls.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: 4_000, maxNetworkRetries: 0 }),
    );
  });

  it('reuses the existing customer on an email collision instead of duplicating', async () => {
    const stripe = fakeStripe([
      { id: 'cus_existing', email: 'dup@example.com', metadata: { uid: 'uid-1' } },
    ]);
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'dup@example.com',
    });

    expect(id).toBe('cus_existing');
    expect(stripe.calls.create).not.toHaveBeenCalled();
    expect(db.docs.get('customers/uid-1')).toMatchObject({
      stripeCustomerId: 'cus_existing',
    });
  });

  it('stamps metadata.uid onto an adopted customer that has none', async () => {
    // e.g. a customer created by hand in the Stripe dashboard. Without the
    // stamp, every webhook for it would take the fallback resolution path.
    const stripe = fakeStripe([
      { id: 'cus_manual', email: 'manual@example.com', metadata: {} },
    ]);
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'manual@example.com',
    });

    expect(id).toBe('cus_manual');
    expect(stripe.calls.update).toHaveBeenCalledWith(
      'cus_manual',
      { metadata: { uid: 'uid-1' } },
      {},
    );
    expect(stripe.calls.create).not.toHaveBeenCalled();
  });

  it('refuses to adopt a customer claimed by a different uid', async () => {
    // Adopting it would point two accounts at one Stripe customer, and the
    // webhook (which trusts metadata.uid first) would credit the wrong one.
    const stripe = fakeStripe([
      { id: 'cus_other', email: 'shared@example.com', metadata: { uid: 'uid-other' } },
    ]);
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'shared@example.com',
    });

    expect(id).toBe('cus_new_1');
    expect(stripe.calls.update).not.toHaveBeenCalled();
    expect(stripe.calls.create).toHaveBeenCalledWith(
      { email: 'shared@example.com', metadata: { uid: 'uid-1' } },
      expect.anything(),
    );
  });

  it('skips silently when stripe is unconfigured', async () => {
    mockGetStripeOrNull.mockReturnValue(null);
    mockStripeMode.mockReturnValue('unconfigured');
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-1',
      email: 'new@example.com',
    });

    expect(id).toBeNull();
    expect(db.docs.get('customers/uid-1')).toMatchObject({ stripeCustomerId: null });
  });

  it('never throws when stripe fails', async () => {
    const stripe = fakeStripe();
    stripe.calls.list.mockRejectedValue(new Error('stripe is down'));
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    await expect(
      linkStripeCustomer({
        db: db.asFirestore(),
        uid: 'uid-1',
        email: 'new@example.com',
      }),
    ).resolves.toBeNull();
  });

  it('never throws when the write-back fails', async () => {
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());
    db.failingUpdates.add('customers/uid-1');

    await expect(
      linkStripeCustomer({
        db: db.asFirestore(),
        uid: 'uid-1',
        email: 'new@example.com',
      }),
    ).resolves.toBeNull();
  });

  it('does not create a partial doc when customers/{uid} is missing', async () => {
    // `update()` on a missing doc must fail rather than conjure a doc holding
    // only `stripeCustomerId` — that would satisfy backfill-customers.mjs's
    // existence check and deny the account its trial clock forever.
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb();

    const id = await linkStripeCustomer({
      db: db.asFirestore(),
      uid: 'uid-missing',
      email: 'nobody@example.com',
    });

    expect(id).toBeNull();
    expect(db.docs.has('customers/uid-missing')).toBe(false);
  });
});

/* ─── bootstrap wiring ─────────────────────────────────────────────────── */

describe('bootstrapUser — stripe customer link', () => {
  const ctx = { auditActor: 'user:uid-1', endpoint: '/test', method: 'POST' };
  const now = new Date('2026-08-01T12:00:00.000Z');

  it('links the minted customers doc using the verified account email', async () => {
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb();

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'signup@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    expect(stripe.calls.create).toHaveBeenCalledWith(
      { email: 'signup@example.com', metadata: { uid: 'uid-1' } },
      expect.anything(),
    );
    expect(db.docs.get('customers/uid-1')).toMatchObject({
      stripeCustomerId: 'cus_new_1',
      billingState: 'trialing',
    });
  });

  it('still creates the user when stripe throws', async () => {
    const stripe = fakeStripe();
    stripe.calls.list.mockRejectedValue(new Error('stripe is down'));
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb();

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'signup@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    expect(db.docs.get('users/uid-1')).toMatchObject({ email: 'signup@example.com' });
    expect(db.docs.get('customers/uid-1')).toMatchObject({ stripeCustomerId: null });
    // The signup audit event still fires — the billing failure is invisible
    // to the user and to the rest of the pipeline.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('makes no stripe calls at all while stripe is unconfigured', async () => {
    // The state for the whole pre-go-live window: signup latency must be
    // exactly what it was before wave 1.2.
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(null);
    mockStripeMode.mockReturnValue('unconfigured');
    const db = new FakeDb();

    const result = await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'signup@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(result.kind).toBe('created');
    expect(stripe.calls.list).not.toHaveBeenCalled();
    expect(stripe.calls.create).not.toHaveBeenCalled();
    expect(db.docs.get('customers/uid-1')).toMatchObject({ stripeCustomerId: null });
  });

  it('does not re-link a customers doc that already has a stripeCustomerId', async () => {
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', {
      ...seededCustomerDoc(),
      stripeCustomerId: 'cus_already',
    });

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'signup@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(stripe.calls.list).not.toHaveBeenCalled();
    expect(db.docs.get('customers/uid-1')).toMatchObject({
      stripeCustomerId: 'cus_already',
    });
  });

  it('links a pre-existing customers doc that was never linked', async () => {
    // The repair shape: `backfill-customers.mjs` minted the billing doc but
    // the users doc never existed, so bootstrap reaches the link.
    const stripe = fakeStripe();
    mockGetStripeOrNull.mockReturnValue(stripe.client);
    const db = new FakeDb().seed('customers/uid-1', seededCustomerDoc());

    await bootstrapUser(ctx, {
      uid: 'uid-1',
      email: 'signup@example.com',
      db: db.asFirestore(),
      now: () => now,
    });

    expect(db.docs.get('customers/uid-1')).toMatchObject({
      stripeCustomerId: 'cus_new_1',
      // The backfill's "clock not started" sentinel is preserved.
      trialEndsAt: null,
    });
  });
});
