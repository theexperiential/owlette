/** @jest-environment node */

/**
 * Trial lifecycle sweep (billing-system wave 2.2).
 *
 * The milestone matrix is the whole point of these tests: day boundaries are
 * exact instants, and a mis-ordered comparison would either page a customer
 * twice or — worse — send "4 days left" after their trial had already ended.
 */

// Sentinels only. The sweep never reaches the real admin SDK: every call
// injects `db`, and a reached `getAdminDb()` throws so an accidental
// production-path regression fails loudly instead of hanging on credentials.
jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  FieldValue: {
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    delete: () => ({ __op: 'delete' }),
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    throw new Error('getAdminDb() must not be reached — inject `db`');
  },
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  FROM_EMAIL: 'owlette <noreply@mail.owlette.app>',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));

import type { Firestore } from 'firebase-admin/firestore';
import { TRIAL_LENGTH_DAYS } from '@/lib/types/customer';
import {
  POST_EXPIRY_ALERT_GRACE_DAYS,
  TRIAL_MILESTONE_FIELD,
  alertEmailsDisabled,
  alertGraceElapsed,
  planTrialLifecycle,
  runTrialLifecycle,
  trialMilestoneInstants,
  type TrialEmailSender,
  type TrialLifecycleCustomer,
} from '@/lib/billing/trialLifecycle.server';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-01T03:00:00.000Z');
const nowMs = NOW.getTime();

/** A trial ending `days` from NOW (negative = already ended). */
const endsIn = (days: number) => new Date(nowMs + days * DAY);

function customer(overrides: Partial<TrialLifecycleCustomer> = {}): TrialLifecycleCustomer {
  return {
    subscriptionStatus: null,
    trialEndsAt: endsIn(7),
    billingState: 'trialing',
    ...overrides,
  };
}

const stamped = { __ts: 1 };

/* ─── milestone instants ───────────────────────────────────────────────── */

describe('trialMilestoneInstants', () => {
  it('derives day 10 and day 13 from the trial start, and expiry from trialEndsAt', () => {
    const endsAt = nowMs;
    const instants = trialMilestoneInstants(endsAt);

    // Trial started TRIAL_LENGTH_DAYS before it ends.
    expect(instants.day10).toBe(endsAt - (TRIAL_LENGTH_DAYS - 10) * DAY);
    expect(instants.day13).toBe(endsAt - (TRIAL_LENGTH_DAYS - 13) * DAY);
    expect(instants.expired).toBe(endsAt);
  });

  it('places day 10 four days before expiry, matching the "4 days left" copy', () => {
    const endsAt = nowMs;
    expect(trialMilestoneInstants(endsAt).day10).toBe(endsAt - 4 * DAY);
  });
});

/* ─── planTrialLifecycle: milestone matrix ─────────────────────────────── */

describe('planTrialLifecycle — milestones', () => {
  it('sends nothing on day 9 (nothing due yet)', () => {
    const plan = planTrialLifecycle(customer({ trialEndsAt: endsIn(5) }), NOW);
    expect(plan.sendMilestone).toBeNull();
    expect(plan.settleMilestones).toEqual([]);
  });

  it('sends day10 at exactly the day-10 instant (boundary is inclusive)', () => {
    const plan = planTrialLifecycle(customer({ trialEndsAt: endsIn(4) }), NOW);
    expect(plan.sendMilestone).toBe('day10');
    expect(plan.settleMilestones).toEqual(['day10']);
  });

  it('does NOT send day10 one millisecond early', () => {
    const trialEndsAt = new Date(nowMs + 4 * DAY + 1);
    expect(planTrialLifecycle(customer({ trialEndsAt }), NOW).sendMilestone).toBeNull();
  });

  it('sends nothing on day 11-12 once day10 is stamped', () => {
    const plan = planTrialLifecycle(
      customer({ trialEndsAt: endsIn(2), trialEmails: { day10At: stamped } }),
      NOW,
    );
    expect(plan.sendMilestone).toBeNull();
  });

  it('sends day13 at exactly the day-13 instant', () => {
    const plan = planTrialLifecycle(
      customer({ trialEndsAt: endsIn(1), trialEmails: { day10At: stamped } }),
      NOW,
    );
    expect(plan.sendMilestone).toBe('day13');
    expect(plan.settleMilestones).toEqual(['day13']);
  });

  it('sends expired at exactly trialEndsAt', () => {
    const plan = planTrialLifecycle(
      customer({
        trialEndsAt: new Date(nowMs),
        trialEmails: { day10At: stamped, day13At: stamped },
      }),
      NOW,
    );
    expect(plan.sendMilestone).toBe('expired');
    expect(plan.settleMilestones).toEqual(['expired']);
  });

  it('never re-sends a milestone that is already stamped', () => {
    const plan = planTrialLifecycle(
      customer({
        trialEndsAt: endsIn(-1),
        billingState: 'expired',
        trialEmails: { day10At: stamped, day13At: stamped, expiredAt: stamped },
      }),
      NOW,
    );
    expect(plan.sendMilestone).toBeNull();
    expect(plan.settleMilestones).toEqual([]);
  });

  it('an expired account stays expired with no duplicate email and no write', () => {
    const plan = planTrialLifecycle(
      customer({
        trialEndsAt: endsIn(-3),
        billingState: 'expired',
        trialEmails: { day10At: stamped, day13At: stamped, expiredAt: stamped },
      }),
      NOW,
    );
    expect(plan.billingState).toBe('expired');
    expect(plan.writeBillingState).toBe(false);
    expect(plan.sendMilestone).toBeNull();
    expect(plan.alertCutoff).toBe('none');
  });

  it('a first sweep long after expiry sends ONLY the expiry notice and settles the rest', () => {
    // The regression this guards: a backlog that culminates in "4 days left"
    // arriving a month after the trial actually ended.
    const plan = planTrialLifecycle(customer({ trialEndsAt: endsIn(-30) }), NOW);
    expect(plan.sendMilestone).toBe('expired');
    expect(plan.settleMilestones).toEqual(['day10', 'day13', 'expired']);
  });

  it('does not resurrect an earlier milestone when the latest due one is stamped', () => {
    // Hand-edited / partially-written state: day13 settled, day10 never was.
    const plan = planTrialLifecycle(
      customer({ trialEndsAt: endsIn(1), trialEmails: { day13At: stamped } }),
      NOW,
    );
    expect(plan.sendMilestone).toBeNull();
  });

  it('never emails an account whose trial clock has not started (null trialEndsAt)', () => {
    const plan = planTrialLifecycle(customer({ trialEndsAt: null }), NOW);
    expect(plan.billingState).toBe('trialing');
    expect(plan.sendMilestone).toBeNull();
    expect(plan.settleMilestones).toEqual([]);
    expect(plan.alertCutoff).toBe('none');
  });

  it('never emails a subscribed account, even mid-trial-window', () => {
    const plan = planTrialLifecycle(
      customer({ subscriptionStatus: 'active', billingState: 'active', trialEndsAt: endsIn(-1) }),
      NOW,
    );
    expect(plan.billingState).toBe('active');
    expect(plan.writeBillingState).toBe(false);
    expect(plan.sendMilestone).toBeNull();
  });

  it('treats past_due as subscribed — no trial mail, no lockout', () => {
    const plan = planTrialLifecycle(
      customer({ subscriptionStatus: 'past_due', billingState: 'active', trialEndsAt: endsIn(-1) }),
      NOW,
    );
    expect(plan.billingState).toBe('active');
    expect(plan.sendMilestone).toBeNull();
  });

  it('never emails a canceled account', () => {
    const plan = planTrialLifecycle(
      customer({
        subscriptionStatus: 'canceled',
        billingState: 'canceled',
        trialEndsAt: endsIn(-40),
      }),
      NOW,
    );
    expect(plan.billingState).toBe('canceled');
    expect(plan.sendMilestone).toBeNull();
    expect(plan.alertCutoff).toBe('none');
  });

  it('still runs the trial clock for an incomplete subscription (nothing was paid)', () => {
    const plan = planTrialLifecycle(
      customer({
        subscriptionStatus: 'incomplete',
        billingState: 'trialing',
        trialEndsAt: new Date(nowMs),
      }),
      NOW,
    );
    expect(plan.billingState).toBe('expired');
    expect(plan.sendMilestone).toBe('expired');
  });
});

/* ─── planTrialLifecycle: billingState mirror ──────────────────────────── */

describe('planTrialLifecycle — billingState mirror', () => {
  it('flips a lapsed trial to expired', () => {
    const plan = planTrialLifecycle(
      customer({ trialEndsAt: endsIn(-1), billingState: 'trialing' }),
      NOW,
    );
    expect(plan.billingState).toBe('expired');
    expect(plan.writeBillingState).toBe(true);
  });

  it('writes nothing when the stored mirror already agrees', () => {
    expect(planTrialLifecycle(customer({ trialEndsAt: endsIn(3) }), NOW).writeBillingState).toBe(
      false,
    );
  });

  it('repairs a mirror that disagrees in the other direction', () => {
    const plan = planTrialLifecycle(
      customer({ trialEndsAt: endsIn(3), billingState: 'expired' }),
      NOW,
    );
    expect(plan.billingState).toBe('trialing');
    expect(plan.writeBillingState).toBe(true);
  });

  it('writes the mirror for a doc that has no billingState field at all', () => {
    const plan = planTrialLifecycle({ trialEndsAt: endsIn(3) }, NOW);
    expect(plan.writeBillingState).toBe(true);
    expect(plan.billingState).toBe('trialing');
  });
});

/* ─── post-expiry alert cutoff ─────────────────────────────────────────── */

describe('post-expiry alert cutoff', () => {
  const expiredAgo = (days: number) =>
    customer({
      trialEndsAt: endsIn(-days),
      billingState: 'expired',
      trialEmails: { day10At: stamped, day13At: stamped, expiredAt: stamped },
    });

  it('leaves alerts on the day before the grace elapses', () => {
    const c = expiredAgo(POST_EXPIRY_ALERT_GRACE_DAYS - 1);
    expect(alertGraceElapsed(c, NOW)).toBe(false);
    expect(planTrialLifecycle(c, NOW).alertCutoff).toBe('none');
  });

  it('stamps the cutoff at exactly expiry + grace (boundary is inclusive)', () => {
    const c = expiredAgo(POST_EXPIRY_ALERT_GRACE_DAYS);
    expect(alertGraceElapsed(c, NOW)).toBe(true);
    expect(planTrialLifecycle(c, NOW).alertCutoff).toBe('set');
  });

  it('does not re-stamp a cutoff that is already set', () => {
    const c = { ...expiredAgo(POST_EXPIRY_ALERT_GRACE_DAYS + 5), alertEmailsDisabledAt: stamped };
    expect(planTrialLifecycle(c, NOW).alertCutoff).toBe('none');
  });

  it('clears a stale cutoff once the account converts', () => {
    const c = customer({
      subscriptionStatus: 'active',
      billingState: 'active',
      trialEndsAt: endsIn(-60),
      alertEmailsDisabledAt: stamped,
    });
    expect(planTrialLifecycle(c, NOW).alertCutoff).toBe('clear');
  });

  it('clears a stale cutoff once the trial is extended back into the future', () => {
    const c = customer({
      trialEndsAt: endsIn(5),
      billingState: 'trialing',
      alertEmailsDisabledAt: stamped,
    });
    expect(planTrialLifecycle(c, NOW).alertCutoff).toBe('clear');
  });

  it('never cuts a canceled subscriber off its trialEndsAt anchor', () => {
    // A subscriber who cancels usually has a long-past trialEndsAt; measuring
    // their grace from it would kill alerts the instant they cancel.
    const c = customer({
      subscriptionStatus: 'canceled',
      billingState: 'canceled',
      trialEndsAt: endsIn(-400),
    });
    expect(alertGraceElapsed(c, NOW)).toBe(false);
  });

  it('never cuts off an account whose clock never started', () => {
    expect(alertGraceElapsed(customer({ trialEndsAt: null }), NOW)).toBe(false);
  });
});

describe('alertEmailsDisabled (the alert pipeline read)', () => {
  it('is false when no flag is stamped', () => {
    expect(alertEmailsDisabled(customer({ trialEndsAt: endsIn(-60) }), NOW)).toBe(false);
  });

  it('is true for a flagged account that is still expired', () => {
    const c = customer({
      trialEndsAt: endsIn(-60),
      billingState: 'expired',
      alertEmailsDisabledAt: stamped,
    });
    expect(alertEmailsDisabled(c, NOW)).toBe(true);
  });

  it('is false the moment a flagged account converts — no waiting for the sweep', () => {
    const c = customer({
      subscriptionStatus: 'active',
      billingState: 'active',
      trialEndsAt: endsIn(-60),
      alertEmailsDisabledAt: stamped,
    });
    expect(alertEmailsDisabled(c, NOW)).toBe(false);
  });

  it('is false for a flagged account whose trial was extended', () => {
    const c = customer({ trialEndsAt: endsIn(10), alertEmailsDisabledAt: stamped });
    expect(alertEmailsDisabled(c, NOW)).toBe(false);
  });

  it('is false for a missing customer doc', () => {
    expect(alertEmailsDisabled(undefined, NOW)).toBe(false);
  });
});

/* ─── runTrialLifecycle ────────────────────────────────────────────────── */

interface Seed {
  id: string;
  customer: Record<string, unknown>;
  /** `null` seeds a customers doc with NO paired users doc. */
  user?: Record<string, unknown> | null;
}

interface FakePage {
  empty: boolean;
  size: number;
  docs: unknown[];
}

interface FakeQuery {
  limit(n: number): FakeQuery;
  startAfter(snap: { id: string }): FakeQuery;
  get(): Promise<FakePage>;
}

class FakeDb {
  readonly customers = new Map<string, Record<string, unknown>>();
  readonly users = new Map<string, Record<string, unknown>>();
  readonly writes: Array<{ id: string; update: Record<string, unknown> }> = [];
  readonly pages: Array<{ limit: number; after: string | null }> = [];
  readonly failWrites = new Set<string>();

  seed(seeds: Seed[]): this {
    for (const s of seeds) {
      this.customers.set(s.id, s.customer);
      if (s.user !== null) this.users.set(s.id, s.user ?? { email: `${s.id}@fleet.test` });
    }
    return this;
  }

  private customerDocs() {
    return Array.from(this.customers.keys()).sort();
  }

  private customersQuery(limit: number, after: string | null): FakeQuery {
    return {
      limit: (n: number) => this.customersQuery(n, after),
      startAfter: (snap: { id: string }) => this.customersQuery(limit, snap.id),
      get: async () => {
        this.pages.push({ limit, after });
        const ids = this.customerDocs()
          .filter((id) => after === null || id > after)
          .slice(0, limit);
        return {
          empty: ids.length === 0,
          size: ids.length,
          docs: ids.map((id) => ({
            id,
            data: () => ({ ...this.customers.get(id) }),
            ref: {
              set: async (update: Record<string, unknown>) => {
                if (this.failWrites.has(id)) throw new Error(`write rejected for ${id}`);
                this.writes.push({ id, update });
              },
            },
          })),
        };
      },
    };
  }

  collection(name: string) {
    if (name === 'customers') {
      return {
        orderBy: () => this.customersQuery(Number.MAX_SAFE_INTEGER, null),
      };
    }
    if (name === 'users') {
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = this.users.get(id);
            return { exists: data !== undefined, data: () => data };
          },
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  }

  writeFor(id: string): Record<string, unknown> | undefined {
    return this.writes.find((w) => w.id === id)?.update;
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

describe('runTrialLifecycle', () => {
  let sent: Array<{ to: string; subject: string; html: string }>;
  let sendEmail: TrialEmailSender;

  beforeEach(() => {
    sent = [];
    sendEmail = async (message) => {
      sent.push(message);
    };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const run = (db: FakeDb, options: { sendEmail?: TrialEmailSender | undefined } = {}) =>
    runTrialLifecycle({
      db: db.asFirestore(),
      now: NOW,
      sendEmail: 'sendEmail' in options ? options.sendEmail : sendEmail,
    });

  it('returns a zeroed summary for an empty collection', async () => {
    const summary = await run(new FakeDb());
    expect(summary).toEqual({
      processed: 0,
      expired: 0,
      emailsSent: { day10: 0, day13: 0, expired: 0 },
      alertCutoffs: 0,
      errors: 0,
    });
  });

  it('flips a lapsed trial to expired and emails the expiry notice once', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-lapsed',
        customer: {
          subscriptionStatus: null,
          billingState: 'trialing',
          trialEndsAt: endsIn(-1),
          trialEmails: { day10At: stamped, day13At: stamped },
        },
      },
    ]);

    const summary = await run(db);

    expect(summary.processed).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.emailsSent).toEqual({ day10: 0, day13: 0, expired: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('acct-lapsed@fleet.test');
    expect(sent[0].subject).toBe('your owlette trial has ended');
    expect(sent[0].html).toContain('billing=choose-plan');

    expect(db.writeFor('acct-lapsed')).toEqual({
      billingState: 'expired',
      trialEmails: { [TRIAL_MILESTONE_FIELD.expired]: { __op: 'serverTimestamp' } },
    });
  });

  it('sends the day-10 notice with the "4 days left" subject', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-d10', customer: { billingState: 'trialing', trialEndsAt: endsIn(4) } },
    ]);

    const summary = await run(db);

    expect(summary.emailsSent).toEqual({ day10: 1, day13: 0, expired: 0 });
    expect(sent[0].subject).toBe('4 days left in your owlette trial');
    expect(db.writeFor('acct-d10')).toEqual({
      trialEmails: { day10At: { __op: 'serverTimestamp' } },
    });
  });

  it('sends the day-13 notice and settles day10 as superseded when it never went out', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-d13', customer: { billingState: 'trialing', trialEndsAt: endsIn(1) } },
    ]);

    await run(db);

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('your owlette trial ends tomorrow');
    expect(db.writeFor('acct-d13')).toEqual({
      trialEmails: {
        day10At: { __op: 'serverTimestamp' },
        day13At: { __op: 'serverTimestamp' },
      },
    });
  });

  it('writes nothing at all for an account with no work owed', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-quiet', customer: { billingState: 'trialing', trialEndsAt: endsIn(9) } },
    ]);

    const summary = await run(db);

    expect(summary.processed).toBe(1);
    expect(db.writes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('leaves a pre-go-live account (null trialEndsAt) completely untouched', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-beta', customer: { billingState: 'trialing', trialEndsAt: null } },
    ]);

    const summary = await run(db);

    expect(summary).toMatchObject({ processed: 1, expired: 0, alertCutoffs: 0, errors: 0 });
    expect(db.writes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('leaves a subscribed account untouched', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-paid',
        customer: {
          subscriptionStatus: 'active',
          billingState: 'active',
          trialEndsAt: endsIn(-90),
        },
      },
    ]);

    const summary = await run(db);

    expect(summary.expired).toBe(0);
    expect(db.writes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('stamps the alert cutoff 30 days after expiry without re-emailing', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-cutoff',
        customer: {
          billingState: 'expired',
          trialEndsAt: endsIn(-POST_EXPIRY_ALERT_GRACE_DAYS),
          trialEmails: { day10At: stamped, day13At: stamped, expiredAt: stamped },
        },
      },
    ]);

    const summary = await run(db);

    expect(summary.alertCutoffs).toBe(1);
    expect(sent).toHaveLength(0);
    expect(db.writeFor('acct-cutoff')).toEqual({
      alertEmailsDisabledAt: { __op: 'serverTimestamp' },
    });
  });

  it('clears a stale alert cutoff on an account that converted', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-back',
        customer: {
          subscriptionStatus: 'active',
          billingState: 'active',
          trialEndsAt: endsIn(-90),
          alertEmailsDisabledAt: stamped,
        },
      },
    ]);

    const summary = await run(db);

    expect(summary.alertCutoffs).toBe(0);
    expect(db.writeFor('acct-back')).toEqual({ alertEmailsDisabledAt: { __op: 'delete' } });
  });

  it('keeps going when one account fails, and reports it', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-a', customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) } },
      { id: 'acct-b', customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) } },
      { id: 'acct-c', customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) } },
    ]);
    db.failWrites.add('acct-b');

    const summary = await run(db);

    expect(summary.processed).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.expired).toBe(2);
    expect(db.writes.map((w) => w.id)).toEqual(['acct-a', 'acct-c']);
  });

  it('counts a missing recipient as an error and leaves the milestone unstamped', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-nouser',
        customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) },
        user: null,
      },
    ]);

    const summary = await run(db);

    expect(summary.errors).toBe(1);
    expect(summary.emailsSent.expired).toBe(0);
    // The state flip still lands — it does not depend on the mail going out.
    expect(db.writeFor('acct-nouser')).toEqual({ billingState: 'expired' });
  });

  it('never mails a soft-deleted account', async () => {
    const db = new FakeDb().seed([
      {
        id: 'acct-deleted',
        customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) },
        user: { email: 'gone@fleet.test', deletedAt: 1_700_000_000_000 },
      },
    ]);

    const summary = await run(db);

    expect(sent).toHaveLength(0);
    expect(summary.errors).toBe(1);
    expect(db.writeFor('acct-deleted')).toEqual({ billingState: 'expired' });
  });

  it('does not stamp a milestone whose send failed — it retries next run', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-bounce', customer: { billingState: 'expired', trialEndsAt: endsIn(-1) } },
    ]);

    const summary = await run(db, {
      sendEmail: async () => {
        throw new Error('resend rejected the message');
      },
    });

    expect(summary.errors).toBe(1);
    expect(summary.emailsSent.expired).toBe(0);
    expect(db.writes).toHaveLength(0);
  });

  it('mirrors billing state but sends nothing when no transport is configured', async () => {
    const db = new FakeDb().seed([
      { id: 'acct-nomail', customer: { billingState: 'trialing', trialEndsAt: endsIn(-1) } },
    ]);

    // No injected sender + the mocked getResend() returns null.
    const summary = await run(db, { sendEmail: undefined });

    expect(summary.emailsSent).toEqual({ day10: 0, day13: 0, expired: 0 });
    expect(summary.errors).toBe(0);
    expect(db.writeFor('acct-nomail')).toEqual({ billingState: 'expired' });
  });

  it('drains the collection across pages instead of stopping after the first', async () => {
    // 320 > the 300-doc page size: a one-page implementation would report 300
    // and silently leave the tail of the fleet unprocessed every single day.
    const seeds: Seed[] = Array.from({ length: 320 }, (_, i) => ({
      id: `acct-${String(i).padStart(4, '0')}`,
      customer: { billingState: 'trialing', trialEndsAt: endsIn(9) },
    }));
    const db = new FakeDb().seed(seeds);

    const summary = await run(db);

    expect(summary.processed).toBe(320);
    expect(db.pages).toHaveLength(2);
    expect(db.pages[0].after).toBeNull();
    expect(db.pages[1].after).toBe('acct-0299');
  });
});
