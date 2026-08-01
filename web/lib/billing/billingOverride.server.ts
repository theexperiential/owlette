/**
 * Admin billing overrides (billing-system task 4.1).
 *
 * The three manual interventions customer success needs on a `customers/{uid}`
 * doc, and the only place any of them may be written:
 *
 *  - **extend trial** — push `trialEndsAt` out, either by a number of days or
 *    to an explicit date.
 *  - **set tier** — comp an account onto `core` / `pro` without a Stripe
 *    subscription behind it.
 *  - **force expire** — end the trial immediately.
 *
 * Lives beside the route rather than inside it so the whole decision matrix is
 * unit-testable without a request or a real Firestore: every entry point takes
 * an injectable `db` and `now`, and returns a discriminated result the route
 * maps to HTTP (same shape as `setUserRole.server.ts`).
 *
 * ## What it never does
 *
 * - **Never hand-sets a `billingState` literal.** Every operation writes
 *   whatever `resolveBillingState()` returns for the *merged* document, so an
 *   override and the daily trial sweep can never disagree about what a doc
 *   means. That is also why the write is a transaction: the resolved value is
 *   derived from fields the patch does not itself carry
 *   (`subscriptionStatus`), and a read-then-write could stamp a stale answer
 *   over a concurrent webhook's fresh one — the same hazard
 *   `writeCustomerBilling()` documents.
 * - **Never mints a missing `customers/{uid}` doc.** An account with no
 *   customer record was never backfilled (`scripts/backfill-customers.mjs`),
 *   and creating a half-populated one from an override would hide that. The
 *   operation reports `not_found` instead.
 *
 * ## Why this is not `writeCustomerBilling()`
 *
 * That helper's `CustomerBillingPatch` is Stripe-shaped: it can express a
 * subscription id and a period end, but not `trialEndsAt`, not the comp
 * provenance fields, and — critically — not the `FieldValue.delete()`
 * sentinels an extension needs to un-stamp stale markers. Widening it would
 * put admin-only concepts into the webhook write path. The transaction is
 * duplicated on purpose; the *resolution rule* is not.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  billingTimestampToMillis,
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import {
  alertGraceElapsed,
  TRIAL_MILESTONE_FIELD,
  trialMilestoneInstants,
  type TrialLifecycleCustomer,
  type TrialMilestone,
} from '@/lib/billing/trialLifecycle.server';
import type { SiteTier } from '@/lib/siteTier';
import type { BillingState, BillingTimestamp } from '@/lib/types/customer';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Longest trial extension a single override may grant, in days. */
export const MAX_TRIAL_EXTENSION_DAYS = 365;

/** Longest comp note we store. Long enough for a sentence, short enough to index. */
export const MAX_COMP_NOTE_LENGTH = 500;

/* ─── comp provenance ──────────────────────────────────────────────────── */

/**
 * Fields an admin tier override stamps alongside `subscriptionTier`, so a
 * comped tier is distinguishable from one Stripe wrote at conversion.
 *
 * `compedTier` is the load-bearing one. The Stripe webhook path
 * (`stripeEventHandlers.ts`) writes `subscriptionTier` and knows nothing about
 * these markers, so a comped account that later converts for real would
 * otherwise keep a `compedAt` that reads as "this tier is a comp" forever.
 * Recording *which* tier the comp granted makes the claim falsifiable:
 * see {@link isCompedTier}.
 */
export interface CompMarkers {
  /** Tier the comp granted. Compared against the live `subscriptionTier`. */
  compedTier?: SiteTier | string | null;
  /** When the comp was applied. */
  compedAt?: BillingTimestamp | null;
  /** uid of the superadmin who applied it. */
  compedBy?: string | null;
  /** Why. Required at write time; free text. */
  compNote?: string | null;
}

/** The `customers/{uid}` fields this module reads. */
export interface BillingOverrideCustomer extends TrialLifecycleCustomer, CompMarkers {
  subscriptionId?: string | null;
  subscriptionTier?: SiteTier | string | null;
}

/**
 * True when the account's current tier is a live comp rather than something a
 * customer is paying for.
 *
 * Both halves are required:
 *
 *  - the comp must still describe the tier in force (`compedTier ===
 *    subscriptionTier`) — otherwise a later Stripe write has superseded it;
 *  - there must be no subscription id — an account that converted is paying,
 *    and labelling its tier "comped" in an ops list would be a lie even if the
 *    tiers happen to match.
 */
export function isCompedTier(customer: BillingOverrideCustomer | null | undefined): boolean {
  if (!customer) return false;
  if (customer.compedAt == null) return false;
  const tier = customer.subscriptionTier;
  if (tier !== 'core' && tier !== 'pro') return false;
  if (customer.compedTier !== tier) return false;
  const subscriptionId = customer.subscriptionId;
  return !(typeof subscriptionId === 'string' && subscriptionId.length > 0);
}

/* ─── inputs ───────────────────────────────────────────────────────────── */

export type BillingOverrideOperation = 'extend_trial' | 'set_tier' | 'force_expire';

/** Every operation the route accepts, as a discriminated union. */
export type BillingOverrideInput =
  | {
      operation: 'extend_trial';
      /**
       * Days to add. Anchored at `max(trialEndsAt, now)` — see
       * {@link extensionAnchorMs}. Mutually exclusive with `trialEndsAt`.
       */
      days?: number;
      /** Explicit new trial end, epoch ms. Mutually exclusive with `days`. */
      trialEndsAt?: number;
    }
  | { operation: 'set_tier'; tier: SiteTier; note: string }
  | { operation: 'force_expire' };

/* ─── results ──────────────────────────────────────────────────────────── */

export interface BillingOverrideApplied {
  kind: 'applied';
  uid: string;
  operation: BillingOverrideOperation;
  /** `resolveBillingState()` over the document as it stood before the write. */
  previousBillingState: BillingState;
  /** `resolveBillingState()` over the merged document actually written. */
  billingState: BillingState;
  /** The trial clock after the write, epoch ms; `null` when unset. */
  trialEndsAt: number | null;
  /** The tier after the write; `null` when the account has none. */
  subscriptionTier: SiteTier | null;
  /** Whether the tier in force is a live comp — see {@link isCompedTier}. */
  comped: boolean;
  /** Milestones whose send-markers were un-stamped, so they can fire again. */
  clearedTrialEmailMarkers: TrialMilestone[];
  /** Whether a stale `alertEmailsDisabledAt` was removed. */
  clearedAlertMute: boolean;
}

export type BillingOverrideResult =
  | BillingOverrideApplied
  | { kind: 'not_found'; uid: string }
  | { kind: 'invalid_input'; field: string; message: string };

export interface BillingOverrideOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
}

/* ─── validation ───────────────────────────────────────────────────────── */

function invalid(field: string, message: string): BillingOverrideResult {
  return { kind: 'invalid_input', field, message };
}

/**
 * Parse an untrusted request body into a {@link BillingOverrideInput}.
 *
 * Exported so the route's contract is testable without a Firestore. Every
 * rejection names the offending field, matching `problemValidation()`'s
 * `{ 'body.x': [...] }` shape.
 */
export function parseBillingOverrideInput(
  raw: unknown,
): { ok: true; input: BillingOverrideInput } | { ok: false; field: string; message: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const operation = body.operation;

  if (operation === 'force_expire') {
    return { ok: true, input: { operation: 'force_expire' } };
  }

  if (operation === 'set_tier') {
    const tier = body.tier;
    if (tier !== 'core' && tier !== 'pro') {
      return { ok: false, field: 'body.tier', message: 'must be one of: core, pro' };
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length === 0) {
      return { ok: false, field: 'body.note', message: 'a reason is required for a tier override' };
    }
    if (note.length > MAX_COMP_NOTE_LENGTH) {
      return {
        ok: false,
        field: 'body.note',
        message: `must be ${MAX_COMP_NOTE_LENGTH} characters or fewer`,
      };
    }
    return { ok: true, input: { operation: 'set_tier', tier, note } };
  }

  if (operation === 'extend_trial') {
    const hasDays = body.days !== undefined && body.days !== null;
    const hasDate = body.trialEndsAt !== undefined && body.trialEndsAt !== null;
    if (hasDays === hasDate) {
      return {
        ok: false,
        field: 'body.days',
        message: 'supply exactly one of days or trialEndsAt',
      };
    }
    if (hasDays) {
      const days = body.days;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > MAX_TRIAL_EXTENSION_DAYS
      ) {
        return {
          ok: false,
          field: 'body.days',
          message: `must be a whole number between 1 and ${MAX_TRIAL_EXTENSION_DAYS}`,
        };
      }
      return { ok: true, input: { operation: 'extend_trial', days } };
    }
    const trialEndsAt = body.trialEndsAt;
    if (typeof trialEndsAt !== 'number' || !Number.isFinite(trialEndsAt)) {
      return {
        ok: false,
        field: 'body.trialEndsAt',
        message: 'must be epoch milliseconds',
      };
    }
    return { ok: true, input: { operation: 'extend_trial', trialEndsAt } };
  }

  return {
    ok: false,
    field: 'body.operation',
    message: 'must be one of: extend_trial, set_tier, force_expire',
  };
}

/* ─── pure planning ────────────────────────────────────────────────────── */

/**
 * The instant a relative extension counts from: the later of the current trial
 * end and now.
 *
 * Anchoring at `trialEndsAt` alone would make "+7 days" a no-op for an account
 * that lapsed a month ago — the arithmetic would land the new deadline three
 * weeks in the past and the customer would still be locked out. "Give them a
 * week" means a week of usable time, so an already-expired clock restarts from
 * now.
 */
export function extensionAnchorMs(trialEndsAtMs: number | null, now: Date): number {
  const nowMs = now.getTime();
  if (trialEndsAtMs === null) return nowMs;
  return Math.max(trialEndsAtMs, nowMs);
}

/**
 * Trial-email markers that no longer describe a past milestone, given a new
 * trial end.
 *
 * Milestones are anchored to `trialEndsAt`, so pushing the deadline out moves
 * every instant with it. A marker left stamped for a milestone that is now in
 * the future would permanently suppress that notice: `planTrialLifecycle()`
 * only sends the latest *unstamped* due milestone, so an extended customer
 * would sail past their new day-13 warning in silence and hit a lockout they
 * were never told about.
 *
 * The converse is left alone on purpose — a milestone still in the past keeps
 * its marker, because that email genuinely was sent and re-sending it would be
 * a duplicate.
 */
export function staleTrialEmailMarkers(
  customer: BillingOverrideCustomer | null | undefined,
  newTrialEndsAtMs: number,
  now: Date,
): TrialMilestone[] {
  const markers = customer?.trialEmails;
  if (!markers) return [];
  const instants = trialMilestoneInstants(newTrialEndsAtMs);
  const nowMs = now.getTime();
  return (Object.keys(TRIAL_MILESTONE_FIELD) as TrialMilestone[]).filter((milestone) => {
    const field = TRIAL_MILESTONE_FIELD[milestone] as keyof typeof markers;
    if (markers[field] == null) return false;
    return instants[milestone] > nowMs;
  });
}

/* ─── applying ─────────────────────────────────────────────────────────── */

/** Narrow a stored tier field to a {@link SiteTier}, or `null`. */
function readTier(value: unknown): SiteTier | null {
  return value === 'core' || value === 'pro' ? value : null;
}

/**
 * Apply one override to `customers/{uid}`.
 *
 * Transactional: `billingState` is derived from the merged document, so the
 * read and the write must not be separable (see the module header).
 */
export async function applyBillingOverride(
  uid: string,
  input: BillingOverrideInput,
  actorUid: string,
  options: BillingOverrideOptions = {},
): Promise<BillingOverrideResult> {
  const db = options.db ?? getAdminDb();
  const now = options.now ?? new Date();
  const ref = db.collection('customers').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not_found', uid } as BillingOverrideResult;

    const customer = (snap.data() ?? {}) as BillingOverrideCustomer;
    const previousBillingState = resolveBillingState(customer as BillingStateSource, now);
    const currentTrialEndsAtMs =
      customer.trialEndsAt == null ? null : billingTimestampToMillis(customer.trialEndsAt);

    const patch: Record<string, unknown> = {};
    let clearedTrialEmailMarkers: TrialMilestone[] = [];

    if (input.operation === 'extend_trial') {
      let newEndsAtMs: number;
      if (input.days !== undefined) {
        // A relative extension needs a clock to be relative to. `null` is the
        // documented pre-go-live sentinel — the account is trialing with no
        // deadline at all, so "+N days" would silently *impose* one and cut
        // their access short. Task 5.3 is what starts those clocks.
        if (currentTrialEndsAtMs === null) {
          return invalid(
            'body.days',
            'this account has no trial clock yet (pre-go-live); set an explicit trialEndsAt instead',
          );
        }
        newEndsAtMs = extensionAnchorMs(currentTrialEndsAtMs, now) + input.days * MS_PER_DAY;
      } else {
        newEndsAtMs = input.trialEndsAt as number;
        if (newEndsAtMs <= now.getTime()) {
          return invalid(
            'body.trialEndsAt',
            'must be in the future; use force_expire to end a trial now',
          );
        }
      }

      patch.trialEndsAt = new Date(newEndsAtMs);
      clearedTrialEmailMarkers = staleTrialEmailMarkers(customer, newEndsAtMs, now);
      if (clearedTrialEmailMarkers.length > 0) {
        // Nested deletes inside a merge-set: `set(..., { merge: true })`
        // deep-merges `trialEmails`, so this un-stamps exactly the named
        // milestones and leaves their siblings intact.
        patch.trialEmails = Object.fromEntries(
          clearedTrialEmailMarkers.map((m) => [TRIAL_MILESTONE_FIELD[m], FieldValue.delete()]),
        );
      }
    } else if (input.operation === 'force_expire') {
      // One millisecond behind `now`, because `resolveBillingState()` treats a
      // deadline of exactly `now` as already past — but a value that reads back
      // as "expired" only by tie-breaking would be indistinguishable from a
      // clock that happened to land on this instant.
      patch.trialEndsAt = new Date(now.getTime() - 1);
    } else {
      patch.subscriptionTier = input.tier;
      patch.compedTier = input.tier;
      patch.compedAt = now;
      patch.compedBy = actorUid;
      patch.compNote = input.note;
    }

    // Project the merged document once, and read every derived answer off it —
    // including the alert-mute decision, which has to see the NEW trial clock.
    const merged: BillingOverrideCustomer = {
      ...customer,
      ...(patch.trialEndsAt !== undefined ? { trialEndsAt: patch.trialEndsAt as Date } : {}),
      ...(patch.subscriptionTier !== undefined
        ? { subscriptionTier: patch.subscriptionTier as SiteTier }
        : {}),
      ...(patch.compedTier !== undefined ? { compedTier: patch.compedTier as SiteTier } : {}),
      ...(patch.compedAt !== undefined ? { compedAt: patch.compedAt as Date } : {}),
    };

    const billingState = resolveBillingState(merged as BillingStateSource, now);
    patch.billingState = billingState;

    // Same rule as the daily sweep's `planAlertCutoff()` 'clear' arm: a marker
    // that no longer describes an elapsed post-expiry grace is inert to
    // `alertEmailsDisabled()` but still reads as "alerts off" to anyone
    // inspecting the record, and would re-arm instantly on a future lapse —
    // skipping the 30 days the customer is owed. An extension or a comp is
    // exactly when that goes stale, so clear it here rather than waiting up to
    // a day for the cron.
    const clearedAlertMute =
      customer.alertEmailsDisabledAt != null && !alertGraceElapsed(merged, now);
    if (clearedAlertMute) patch.alertEmailsDisabledAt = FieldValue.delete();

    tx.set(ref, patch, { merge: true });

    const finalTier = readTier(merged.subscriptionTier);
    return {
      kind: 'applied',
      uid,
      operation: input.operation,
      previousBillingState,
      billingState,
      trialEndsAt:
        patch.trialEndsAt !== undefined
          ? (patch.trialEndsAt as Date).getTime()
          : currentTrialEndsAtMs,
      subscriptionTier: finalTier,
      comped: isCompedTier(merged),
      clearedTrialEmailMarkers,
      clearedAlertMute,
    } as BillingOverrideResult;
  });
}
