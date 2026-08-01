/**
 * @jest-environment node
 *
 * Admin billing overrides (billing-system task 4.1).
 *
 * The three interventions and everything they drag along: the extension
 * anchor, the trial-email markers an extension has to un-stamp, the alert-mute
 * clear, comp provenance, and the invariant that binds them all — every
 * operation writes `billingState` from `resolveBillingState()` over the
 * *merged* document, never a hand-picked literal.
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
  applyBillingOverride,
  extensionAnchorMs,
  isCompedTier,
  MAX_COMP_NOTE_LENGTH,
  MAX_TRIAL_EXTENSION_DAYS,
  parseBillingOverrideInput,
  staleTrialEmailMarkers,
  type BillingOverrideApplied,
} from '@/lib/billing/billingOverride.server';
import { TRIAL_LENGTH_DAYS } from '@/lib/types/customer';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const ACTOR = 'uid_admin';
const DELETE = { __op: 'delete' };

/* ─── firestore fake ───────────────────────────────────────────────────── */

interface Write {
  uid: string;
  patch: Record<string, unknown>;
  options: unknown;
}

class FakeDb {
  readonly customers = new Map<string, Record<string, unknown>>();
  readonly writes: Write[] = [];

  seed(uid: string, customer: Record<string, unknown>): this {
    this.customers.set(uid, customer);
    return this;
  }

  collection(name: string) {
    if (name !== 'customers') throw new Error(`unexpected collection: ${name}`);
    return { doc: (uid: string) => ({ __uid: uid }) };
  }

  async runTransaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: { __uid: string }) => {
        const data = this.customers.get(ref.__uid);
        return { exists: data !== undefined, data: () => data };
      },
      set: (ref: { __uid: string }, patch: Record<string, unknown>, options: unknown) => {
        this.writes.push({ uid: ref.__uid, patch, options });
      },
    };
    return cb(tx);
  }

  patchFor(uid: string): Record<string, unknown> | undefined {
    return this.writes.find((w) => w.uid === uid)?.patch;
  }

  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

/** Apply an override against a seeded fake and assert it succeeded. */
async function applyOk(
  db: FakeDb,
  uid: string,
  input: Parameters<typeof applyBillingOverride>[1],
  now: Date = NOW,
): Promise<BillingOverrideApplied> {
  const result = await applyBillingOverride(uid, input, ACTOR, { db: db.asFirestore(), now });
  if (result.kind !== 'applied') {
    throw new Error(`expected applied, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result;
}

/* ─── pure helpers ─────────────────────────────────────────────────────── */

describe('isCompedTier', () => {
  it('is true when the comp still describes the tier in force', () => {
    expect(
      isCompedTier({ subscriptionTier: 'pro', compedTier: 'pro', compedAt: NOW }),
    ).toBe(true);
  });

  it('is false once a later stripe write has moved the tier', () => {
    // The webhook path writes `subscriptionTier` and knows nothing about the
    // comp markers, so a stale `compedAt` must not keep claiming the account.
    expect(
      isCompedTier({ subscriptionTier: 'core', compedTier: 'pro', compedAt: NOW }),
    ).toBe(false);
  });

  it('is false for an account that actually pays', () => {
    expect(
      isCompedTier({
        subscriptionTier: 'pro',
        compedTier: 'pro',
        compedAt: NOW,
        subscriptionId: 'sub_123',
      }),
    ).toBe(false);
  });

  it('is false with no comp marker at all', () => {
    expect(isCompedTier({ subscriptionTier: 'pro' })).toBe(false);
    expect(isCompedTier(null)).toBe(false);
  });
});

describe('extensionAnchorMs', () => {
  it('anchors a live trial at its own deadline', () => {
    const future = NOW.getTime() + 3 * MS_PER_DAY;
    expect(extensionAnchorMs(future, NOW)).toBe(future);
  });

  it('anchors a lapsed trial at now, so the days granted are usable', () => {
    expect(extensionAnchorMs(NOW.getTime() - 30 * MS_PER_DAY, NOW)).toBe(NOW.getTime());
  });

  it('anchors an absent clock at now', () => {
    expect(extensionAnchorMs(null, NOW)).toBe(NOW.getTime());
  });
});

describe('staleTrialEmailMarkers', () => {
  it('clears only the milestones the new deadline pushes into the future', () => {
    // Trial ends now; extend by one day. day10 (T-4d) and day13 (T-1d) stay
    // past, expiry moves to tomorrow.
    const markers = { day10At: NOW, day13At: NOW, expiredAt: NOW };
    const stale = staleTrialEmailMarkers(
      { trialEmails: markers },
      NOW.getTime() + MS_PER_DAY,
      NOW,
    );
    expect(stale).toEqual(['expired']);
  });

  it('clears every stamped milestone when the extension outruns them all', () => {
    const markers = { day10At: NOW, day13At: NOW, expiredAt: NOW };
    const stale = staleTrialEmailMarkers(
      { trialEmails: markers },
      NOW.getTime() + TRIAL_LENGTH_DAYS * MS_PER_DAY,
      NOW,
    );
    expect(stale.sort()).toEqual(['day10', 'day13', 'expired']);
  });

  it('never reports a milestone that was never stamped', () => {
    const stale = staleTrialEmailMarkers(
      { trialEmails: { day10At: NOW } },
      NOW.getTime() + 30 * MS_PER_DAY,
      NOW,
    );
    expect(stale).toEqual(['day10']);
  });

  it('is empty when nothing has been stamped', () => {
    expect(staleTrialEmailMarkers({}, NOW.getTime() + MS_PER_DAY, NOW)).toEqual([]);
  });
});

describe('parseBillingOverrideInput', () => {
  it('accepts each operation', () => {
    expect(parseBillingOverrideInput({ operation: 'force_expire' })).toEqual({
      ok: true,
      input: { operation: 'force_expire' },
    });
    expect(parseBillingOverrideInput({ operation: 'extend_trial', days: 7 })).toEqual({
      ok: true,
      input: { operation: 'extend_trial', days: 7 },
    });
    expect(
      parseBillingOverrideInput({ operation: 'set_tier', tier: 'pro', note: '  conf comp ' }),
    ).toEqual({ ok: true, input: { operation: 'set_tier', tier: 'pro', note: 'conf comp' } });
  });

  it('rejects an unknown operation', () => {
    const result = parseBillingOverrideInput({ operation: 'refund' });
    expect(result).toMatchObject({ ok: false, field: 'body.operation' });
  });

  it('requires exactly one of days / trialEndsAt', () => {
    expect(parseBillingOverrideInput({ operation: 'extend_trial' })).toMatchObject({
      ok: false,
      field: 'body.days',
    });
    expect(
      parseBillingOverrideInput({ operation: 'extend_trial', days: 3, trialEndsAt: 1 }),
    ).toMatchObject({ ok: false, field: 'body.days' });
  });

  it.each([0, -1, 1.5, MAX_TRIAL_EXTENSION_DAYS + 1, '7'])(
    'rejects days = %p',
    (days) => {
      expect(parseBillingOverrideInput({ operation: 'extend_trial', days })).toMatchObject({
        ok: false,
        field: 'body.days',
      });
    },
  );

  it('requires a tier and a reason for a comp', () => {
    expect(
      parseBillingOverrideInput({ operation: 'set_tier', tier: 'enterprise', note: 'x' }),
    ).toMatchObject({ ok: false, field: 'body.tier' });
    expect(
      parseBillingOverrideInput({ operation: 'set_tier', tier: 'pro', note: '   ' }),
    ).toMatchObject({ ok: false, field: 'body.note' });
    expect(
      parseBillingOverrideInput({
        operation: 'set_tier',
        tier: 'pro',
        note: 'x'.repeat(MAX_COMP_NOTE_LENGTH + 1),
      }),
    ).toMatchObject({ ok: false, field: 'body.note' });
  });
});

/* ─── applying ─────────────────────────────────────────────────────────── */

describe('applyBillingOverride — extend_trial', () => {
  it('pushes a live trial out and rewrites the resolved state', async () => {
    const trialEndsAt = new Date(NOW.getTime() + 3 * MS_PER_DAY);
    const db = new FakeDb().seed('u1', { trialEndsAt, billingState: 'trialing' });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', days: 7 });

    expect(result.billingState).toBe('trialing');
    expect(result.previousBillingState).toBe('trialing');
    expect(result.trialEndsAt).toBe(trialEndsAt.getTime() + 7 * MS_PER_DAY);

    const patch = db.patchFor('u1')!;
    expect((patch.trialEndsAt as Date).getTime()).toBe(trialEndsAt.getTime() + 7 * MS_PER_DAY);
    expect(patch.billingState).toBe('trialing');
    expect(db.writes[0].options).toEqual({ merge: true });
  });

  it('revives a lapsed account, anchoring the grant at now', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() - 30 * MS_PER_DAY),
      billingState: 'expired',
    });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', days: 7 });

    expect(result.previousBillingState).toBe('expired');
    expect(result.billingState).toBe('trialing');
    expect(result.trialEndsAt).toBe(NOW.getTime() + 7 * MS_PER_DAY);
  });

  it('lifts a stale alert mute so the account is not left silently un-paged', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() - 40 * MS_PER_DAY),
      billingState: 'expired',
      alertEmailsDisabledAt: new Date(NOW.getTime() - 10 * MS_PER_DAY),
    });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', days: 14 });

    expect(result.clearedAlertMute).toBe(true);
    expect(db.patchFor('u1')!.alertEmailsDisabledAt).toEqual(DELETE);
  });

  it('un-stamps only the trial emails the new clock has not yet passed', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime()),
      billingState: 'expired',
      trialEmails: { day10At: NOW, day13At: NOW, expiredAt: NOW },
    });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', days: 1 });

    expect(result.clearedTrialEmailMarkers).toEqual(['expired']);
    expect(db.patchFor('u1')!.trialEmails).toEqual({ expiredAt: DELETE });
  });

  it('leaves trialEmails out of the patch when nothing went stale', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() + MS_PER_DAY),
      billingState: 'trialing',
    });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', days: 5 });

    expect(result.clearedTrialEmailMarkers).toEqual([]);
    expect(db.patchFor('u1')).not.toHaveProperty('trialEmails');
  });

  it('refuses a relative extension on a pre-go-live account with no clock', async () => {
    const db = new FakeDb().seed('u1', { trialEndsAt: null, billingState: 'trialing' });

    const result = await applyBillingOverride(
      'u1',
      { operation: 'extend_trial', days: 7 },
      ACTOR,
      { db: db.asFirestore(), now: NOW },
    );

    expect(result).toMatchObject({ kind: 'invalid_input', field: 'body.days' });
    expect(db.writes).toHaveLength(0);
  });

  it('accepts an explicit future date, including on an account with no clock', async () => {
    const target = NOW.getTime() + 21 * MS_PER_DAY;
    const db = new FakeDb().seed('u1', { trialEndsAt: null, billingState: 'trialing' });

    const result = await applyOk(db, 'u1', { operation: 'extend_trial', trialEndsAt: target });

    expect(result.trialEndsAt).toBe(target);
    expect(result.billingState).toBe('trialing');
  });

  it('refuses an explicit date in the past', async () => {
    const db = new FakeDb().seed('u1', { trialEndsAt: NOW, billingState: 'trialing' });

    const result = await applyBillingOverride(
      'u1',
      { operation: 'extend_trial', trialEndsAt: NOW.getTime() - 1 },
      ACTOR,
      { db: db.asFirestore(), now: NOW },
    );

    expect(result).toMatchObject({ kind: 'invalid_input', field: 'body.trialEndsAt' });
    expect(db.writes).toHaveLength(0);
  });
});

describe('applyBillingOverride — set_tier', () => {
  it('stamps the comp provenance alongside the tier', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() + MS_PER_DAY),
      billingState: 'trialing',
    });

    const result = await applyOk(db, 'u1', {
      operation: 'set_tier',
      tier: 'pro',
      note: 'conference sponsor',
    });

    expect(result.subscriptionTier).toBe('pro');
    expect(result.comped).toBe(true);

    const patch = db.patchFor('u1')!;
    expect(patch).toMatchObject({
      subscriptionTier: 'pro',
      compedTier: 'pro',
      compedAt: NOW,
      compedBy: ACTOR,
      compNote: 'conference sponsor',
    });
  });

  it('still rewrites billingState even though a tier does not change it', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() - MS_PER_DAY),
      billingState: 'trialing', // stale mirror
    });

    const result = await applyOk(db, 'u1', { operation: 'set_tier', tier: 'core', note: 'x' });

    expect(result.billingState).toBe('expired');
    expect(db.patchFor('u1')!.billingState).toBe('expired');
  });

  it('does not label a paying account comped', async () => {
    const db = new FakeDb().seed('u1', {
      subscriptionId: 'sub_123',
      subscriptionStatus: 'active',
      trialEndsAt: new Date(NOW.getTime() - MS_PER_DAY),
    });

    const result = await applyOk(db, 'u1', { operation: 'set_tier', tier: 'pro', note: 'x' });

    expect(result.comped).toBe(false);
    expect(result.billingState).toBe('active');
  });

  it('leaves a genuinely elapsed alert mute alone', async () => {
    // Expired 40 days ago and never extended: the 30-day grace really has run
    // out, so the mute is correct and must not be lifted by an unrelated comp.
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() - 40 * MS_PER_DAY),
      alertEmailsDisabledAt: new Date(NOW.getTime() - 10 * MS_PER_DAY),
    });

    const result = await applyOk(db, 'u1', { operation: 'set_tier', tier: 'core', note: 'x' });

    expect(result.clearedAlertMute).toBe(false);
    expect(db.patchFor('u1')).not.toHaveProperty('alertEmailsDisabledAt');
  });
});

describe('applyBillingOverride — force_expire', () => {
  it('flips a live trial to expired', async () => {
    const db = new FakeDb().seed('u1', {
      trialEndsAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      billingState: 'trialing',
    });

    const result = await applyOk(db, 'u1', { operation: 'force_expire' });

    expect(result.previousBillingState).toBe('trialing');
    expect(result.billingState).toBe('expired');
    expect(result.trialEndsAt).toBe(NOW.getTime() - 1);
    expect(db.patchFor('u1')!.billingState).toBe('expired');
  });

  it('cannot expire an account stripe says is subscribed', async () => {
    const db = new FakeDb().seed('u1', {
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      trialEndsAt: new Date(NOW.getTime() + MS_PER_DAY),
    });

    const result = await applyOk(db, 'u1', { operation: 'force_expire' });

    // Stripe is authoritative once a subscription exists — the clock moves,
    // the entitlement does not, and the caller is told so.
    expect(result.billingState).toBe('active');
  });
});

describe('applyBillingOverride — missing customer', () => {
  it('reports not_found instead of minting a partial doc', async () => {
    const db = new FakeDb();

    const result = await applyBillingOverride('ghost', { operation: 'force_expire' }, ACTOR, {
      db: db.asFirestore(),
      now: NOW,
    });

    expect(result).toEqual({ kind: 'not_found', uid: 'ghost' });
    expect(db.writes).toHaveLength(0);
  });
});
