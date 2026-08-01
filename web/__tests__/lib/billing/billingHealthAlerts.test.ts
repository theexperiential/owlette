/** @jest-environment node */

/**
 * Subscription health alerts (billing-system wave 4.3).
 *
 * The wire-in — which Stripe event raises which kind, and the past_due edge
 * check — is pinned in `stripeEventHandlers.test.ts`. This suite pins the
 * module's own contract: the cooldown boundary, who gets mailed when one of
 * the two audiences is missing, and the promise that nothing in here ever
 * throws at its caller.
 */

// The transport is consulted per send, so flipping `mockResendConfigured`
// exercises an unconfigured deployment without re-mocking. `mock`-prefixed
// names are the only out-of-scope references jest's hoisting permits.
const mockResendSend = jest.fn();
let mockResendConfigured = true;

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => (mockResendConfigured ? { emails: { send: mockResendSend } } : null),
  FROM_EMAIL: 'owlette <noreply@mail.owlette.app>',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  HEALTH_ALERT_COOLDOWN_MS,
  HEALTH_ALERTS_FIELD,
  maybeSendBillingHealthAlert,
  type BillingHealthAlertKind,
} from '@/lib/billing/billingHealthAlerts.server';

/* ─── fixtures ─────────────────────────────────────────────────────────── */

type Doc = Record<string, unknown>;

const NOW = new Date('2026-08-01T12:00:00.000Z');
const UID = 'owner-1';
const OWNER_EMAIL = 'owner@example.com';
const OPS_EMAIL = 'ops@owlette.test';
const EVENT_ID = 'evt_health_1';

/** Merge with Firestore's `{ merge: true }` semantics: maps merge, scalars replace. */
function deepMerge(prev: Doc, next: Doc): Doc {
  const out: Doc = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    const existing = out[key];
    const bothMaps =
      value?.constructor === Object && (existing as Doc | undefined)?.constructor === Object;
    out[key] = bothMaps ? deepMerge(existing as Doc, value as Doc) : value;
  }
  return out;
}

/**
 * Two documents and nothing else — the module only ever touches
 * `customers/{uid}` (cooldown marker + reported state) and `users/{uid}`
 * (the owner's address).
 */
class FakeDb {
  readonly customers = new Map<string, Doc>();
  readonly users = new Map<string, Doc>();
  readonly writes: Doc[] = [];
  failCustomerRead = false;
  failUserRead = false;

  seedCustomer(data: Doc): this {
    this.customers.set(UID, data);
    return this;
  }

  seedUser(data: Doc | null): this {
    if (data === null) this.users.delete(UID);
    else this.users.set(UID, data);
    return this;
  }

  customer(): Doc | undefined {
    return this.customers.get(UID);
  }

  collection(name: string) {
    if (name === 'customers') {
      return {
        doc: (id: string) => ({
          get: async () => {
            if (this.failCustomerRead) throw new Error('simulated firestore failure');
            const data = this.customers.get(id);
            return { exists: data !== undefined, data: () => data };
          },
          set: async (data: Doc) => {
            this.writes.push(data);
            this.customers.set(id, deepMerge(this.customers.get(id) ?? {}, data));
          },
        }),
      };
    }
    if (name === 'users') {
      return {
        doc: (id: string) => ({
          get: async () => {
            if (this.failUserRead) throw new Error('simulated firestore failure');
            const data = this.users.get(id);
            return { exists: data !== undefined, data: () => data };
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

/** A converted account with a live subscription and a reachable owner. */
function subscribed(customer: Doc = {}): FakeDb {
  return new FakeDb()
    .seedCustomer({
      stripeCustomerId: 'cus_test123',
      subscriptionId: 'sub_test123',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      billingState: 'active',
      ...customer,
    })
    .seedUser({ email: OWNER_EMAIL });
}

function alert(db: FakeDb, kind: BillingHealthAlertKind = 'subscription_canceled') {
  return maybeSendBillingHealthAlert(kind, UID, {
    db: db.asFirestore(),
    now: NOW,
    eventId: EVENT_ID,
    eventType: 'customer.subscription.deleted',
    objectId: 'sub_test123',
  });
}

function sentMessages(): Array<{ to: string[]; subject: string; html: string }> {
  return mockResendSend.mock.calls.map(
    ([message]) => message as { to: string[]; subject: string; html: string },
  );
}

function sentTo(): string[] {
  return sentMessages().flatMap((m) => m.to);
}

/** The marker map the last write stamped, if any. */
function stampedMarkers(db: FakeDb): Doc | undefined {
  return db.customer()?.[HEALTH_ALERTS_FIELD] as Doc | undefined;
}

/* ─── tests ────────────────────────────────────────────────────────────── */

describe('maybeSendBillingHealthAlert', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ADMIN_EMAIL_DEV = OPS_EMAIL;
    mockResendConfigured = true;
    mockResendSend.mockResolvedValue({ data: { id: 'email_test' }, error: null });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  /* --- audiences ------------------------------------------------------- */

  it('mails the owner and the ops address, then stamps the marker', async () => {
    const db = subscribed();

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 2 });
    expect(sentTo()).toEqual([OWNER_EMAIL, OPS_EMAIL]);
    expect(stampedMarkers(db)).toEqual({ subscription_canceled: NOW });
  });

  it('gives each audience its own copy', async () => {
    const db = subscribed();

    await alert(db);
    const [owner, ops] = sentMessages();

    // Customer-facing: calm, lowercase, no internal identifiers.
    expect(owner.subject).toBe('your owlette subscription was canceled');
    expect(owner.html).not.toContain(UID);
    expect(owner.html).not.toContain(EVENT_ID);

    // Ops-facing: uid, event id, and the state at the time of the alert.
    expect(ops.subject).toBe(`[TEST] billing: subscription canceled — ${UID}`);
    expect(ops.html).toContain(UID);
    expect(ops.html).toContain(EVENT_ID);
    expect(ops.html).toContain('sub_test123');
    expect(ops.html).toContain('customer.subscription.deleted');
  });

  it.each([
    ['subscription_canceled', '/dashboard?billing=choose-plan'],
    ['payment_failed', '/dashboard'],
    ['past_due', '/dashboard'],
  ] as Array<[BillingHealthAlertKind, string]>)(
    'points a %s owner email at %s',
    async (kind, path) => {
      const db = subscribed();

      await alert(db, kind);

      const [owner] = sentMessages();
      expect(owner.html).toContain(`https://dev.owlette.app${path}`);
      // Only the cancellation routes to the tier picker.
      if (kind !== 'subscription_canceled') {
        expect(owner.html).not.toContain('billing=choose-plan');
      }
    },
  );

  it('mails ops alone when the owner has no deliverable address', async () => {
    const db = subscribed().seedUser(null);

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 1 });
    expect(sentTo()).toEqual([OPS_EMAIL]);
    expect(stampedMarkers(db)).toEqual({ subscription_canceled: NOW });
  });

  it('never mails a soft-deleted owner', async () => {
    const db = subscribed().seedUser({ email: OWNER_EMAIL, deletedAt: 1_785_000_000 });

    await alert(db);

    expect(sentTo()).toEqual([OPS_EMAIL]);
  });

  it('mails the owner alone when no ops address is configured', async () => {
    delete process.env.ADMIN_EMAIL_DEV;
    const db = subscribed();

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 1 });
    expect(sentTo()).toEqual([OWNER_EMAIL]);
  });

  it('reports no_recipients when neither audience is reachable', async () => {
    delete process.env.ADMIN_EMAIL_DEV;
    const db = subscribed().seedUser(null);

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'no_recipients', sent: 0 });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('still mails ops when the owner lookup throws', async () => {
    const db = subscribed();
    db.failUserRead = true;

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 1 });
    expect(sentTo()).toEqual([OPS_EMAIL]);
  });

  /* --- cooldown --------------------------------------------------------- */

  it('suppresses a repeat inside the window without touching the marker', async () => {
    const lastSent = new Date(NOW.getTime() - (HEALTH_ALERT_COOLDOWN_MS - 1));
    const db = subscribed({ healthAlerts: { subscription_canceled: lastSent } });

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'cooldown', sent: 0 });
    expect(mockResendSend).not.toHaveBeenCalled();
    // A suppressed alert must never extend its own cooldown.
    expect(db.writes).toEqual([]);
    expect(stampedMarkers(db)).toEqual({ subscription_canceled: lastSent });
  });

  it('sends once the window has exactly elapsed', async () => {
    const lastSent = new Date(NOW.getTime() - HEALTH_ALERT_COOLDOWN_MS);
    const db = subscribed({ healthAlerts: { subscription_canceled: lastSent } });

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 2 });
    expect(stampedMarkers(db)).toEqual({ subscription_canceled: NOW });
  });

  it('scopes the cooldown per kind', async () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const db = subscribed({ healthAlerts: { payment_failed: recent } });

    const result = await alert(db, 'subscription_canceled');

    expect(result).toEqual({ outcome: 'sent', sent: 2 });
    expect(stampedMarkers(db)).toEqual({
      payment_failed: recent,
      subscription_canceled: NOW,
    });
  });

  it('accepts a Firestore Timestamp-shaped marker', async () => {
    const lastSent = { toMillis: () => NOW.getTime() - 60_000 };
    const db = subscribed({ healthAlerts: { subscription_canceled: lastSent } });

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'cooldown', sent: 0 });
  });

  it('fails open on an unreadable marker rather than swallowing the alert', async () => {
    const db = subscribed({ healthAlerts: { subscription_canceled: 'not-a-time' } });

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 2 });
  });

  /* --- failure handling -------------------------------------------------- */

  it('skips at debug level when resend is unconfigured', async () => {
    mockResendConfigured = false;
    const db = subscribed();

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'no_transport', sent: 0 });
    expect(db.writes).toEqual([]);
    expect(console.debug).toHaveBeenCalledWith(
      expect.stringContaining('resend not configured'),
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('stamps when one audience lands and the other fails', async () => {
    mockResendSend
      .mockRejectedValueOnce(new Error('owner send rejected'))
      .mockResolvedValueOnce({ data: { id: 'email_ops' }, error: null });
    const db = subscribed();

    const result = await alert(db);

    // One duplicate next time beats burning the alert for the audience that
    // did receive it.
    expect(result).toEqual({ outcome: 'sent', sent: 1 });
    expect(stampedMarkers(db)).toEqual({ subscription_canceled: NOW });
  });

  it('leaves the marker unstamped when every send fails', async () => {
    mockResendSend.mockRejectedValue(new Error('resend is down'));
    const db = subscribed();

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'failed', sent: 0 });
    expect(db.writes).toEqual([]);
  });

  it('treats a resend error response as a failed send', async () => {
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    const db = subscribed();

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'failed', sent: 0 });
    expect(db.writes).toEqual([]);
  });

  it('never throws when firestore is unreachable', async () => {
    const db = subscribed();
    db.failCustomerRead = true;

    await expect(alert(db)).resolves.toEqual({ outcome: 'failed', sent: 0 });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('alerts an account with no customers doc at all', async () => {
    const db = new FakeDb().seedUser({ email: OWNER_EMAIL });

    const result = await alert(db);

    expect(result).toEqual({ outcome: 'sent', sent: 2 });
    // No stored subscription: the ops copy reports the trial-clock fallback
    // rather than inventing a paid state.
    expect(sentMessages()[1].html).toContain('trialing');
  });
});
