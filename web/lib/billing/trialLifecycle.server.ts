/**
 * Trial lifecycle sweep (billing-system wave 2.2).
 *
 * The daily pass over `customers/{uid}` that moves the app-managed 14-day
 * trial forward: it re-mirrors `billingState`, sends the three trial notices
 * (day 10, day 13, expiry), and stamps the post-expiry cutoff after which
 * machine-offline alert emails stop.
 *
 * Lives beside the route rather than inside it so the whole decision matrix
 * is unit-testable without a request, a Firestore, or a mail transport:
 * {@link planTrialLifecycle} is pure, and {@link runTrialLifecycle} takes an
 * injectable `db` / `now` / `sendEmail`.
 *
 * ## What it never does
 *
 * - **Never hand-sets a `billingState` literal.** The value written is
 *   whatever `resolveBillingState()` returns, so the cron and every gate can
 *   never disagree about what a doc means.
 * - **Never emails an account whose `trialEndsAt` is `null`.** That is the
 *   documented pre-go-live sentinel (see `Customer.trialEndsAt`): the clock
 *   has not started, so there is no milestone to be at and no end date to
 *   put in the copy. Task 5.3 stamps those docs at T0 and the normal
 *   schedule takes over from there.
 * - **Never emails a subscribed or canceled account.** `'active'` and
 *   `'canceled'` are produced only by the subscription branch of the
 *   resolver; once a subscription exists the trial clock is history.
 */
import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  billingTimestampToMillis,
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import { TRIAL_LENGTH_DAYS, type BillingState, type BillingTimestamp } from '@/lib/types/customer';
import { getResend, FROM_EMAIL, isProduction } from '@/lib/resendClient.server';
import {
  buildTrialEmail,
  CHOOSE_PLAN_QUERY,
  type TrialEmailMilestone,
} from '@/lib/emailTemplates.server';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Log prefix, shared by the module and its route so a run greps as one unit. */
const LOG = '[cron/billing-trial-lifecycle]';

/* ─── milestones ───────────────────────────────────────────────────────── */

/** The three trial notices, in the order they come due. */
export type TrialMilestone = TrialEmailMilestone;

/**
 * Day-of-trial each reminder fires on, counted from the trial's start
 * (`trialEndsAt - TRIAL_LENGTH_DAYS`). Day 10 of 14 is "4 days left"; day 13
 * is "tomorrow". Expiry is `trialEndsAt` itself, so it is derived rather
 * than listed here — hardcoding `14` would let it drift from
 * `TRIAL_LENGTH_DAYS`.
 */
export const TRIAL_REMINDER_DAY = { day10: 10, day13: 13 } as const;

/** Ordered oldest → newest. The run acts on the LATEST due milestone. */
const MILESTONE_ORDER: readonly TrialMilestone[] = ['day10', 'day13', 'expired'] as const;

/**
 * `trialEmails` sub-field each milestone stamps once settled. The markers
 * live on the customers doc rather than a side collection so "has this
 * account been told?" is answerable from the same read that resolves its
 * billing state.
 */
export const TRIAL_MILESTONE_FIELD: Record<TrialMilestone, string> = {
  day10: 'day10At',
  day13: 'day13At',
  expired: 'expiredAt',
};

/**
 * Days after trial expiry that machine-offline alert emails keep flowing.
 * From the plan's lockout matrix: an expired account still gets paged about
 * a dead machine for a month, because going dark on someone evaluating a
 * reactivation is how a recoverable lapse becomes a churned customer.
 */
export const POST_EXPIRY_ALERT_GRACE_DAYS = 30;

/* ─── customer shape ───────────────────────────────────────────────────── */

/** Per-milestone send markers as stored under `customers/{uid}.trialEmails`. */
export interface TrialEmailMarkers {
  day10At?: BillingTimestamp | null;
  day13At?: BillingTimestamp | null;
  expiredAt?: BillingTimestamp | null;
}

/**
 * The customers-doc fields this sweep reads. Extends the resolver's narrow
 * source shape, so a raw Firestore document can be passed straight in.
 */
export interface TrialLifecycleCustomer extends BillingStateSource {
  /** Cached mirror. Rewritten whenever it disagrees with the resolver. */
  billingState?: BillingState | string | null;
  trialEmails?: TrialEmailMarkers | null;
  /** Set once the post-expiry alert grace has fully elapsed; cleared if it stops applying. */
  alertEmailsDisabledAt?: BillingTimestamp | null;
}

/* ─── pure planning ────────────────────────────────────────────────────── */

/** What the alert-cutoff flag needs doing to it this run. */
export type AlertCutoffAction = 'set' | 'clear' | 'none';

export interface TrialLifecyclePlan {
  /** Authoritative state per `resolveBillingState()`. */
  billingState: BillingState;
  /** True when the stored mirror disagrees and must be rewritten. */
  writeBillingState: boolean;
  /** Milestone whose email goes out this run; `null` when none is owed. */
  sendMilestone: TrialMilestone | null;
  /**
   * The account's trial end, ready for the email copy. `null` for the
   * pre-go-live sentinel or an unreadable value — and therefore never `null`
   * when `sendMilestone` is set, since neither case can produce a milestone.
   * Carried here so the sender never re-derives (and never re-disagrees with)
   * the date the milestone was chosen from.
   */
  trialEndsAt: Date | null;
  /**
   * Milestones to stamp once that email lands. Always contains
   * `sendMilestone`, plus any earlier milestone that came due while nothing
   * was running — those are stamped *superseded*, never emailed, so an
   * account first swept a month late gets "your trial ended" and not a
   * backlog culminating in "4 days left".
   */
  settleMilestones: TrialMilestone[];
  alertCutoff: AlertCutoffAction;
}

/** Epoch-ms instant of each milestone for a trial ending at `trialEndsAtMs`. */
export function trialMilestoneInstants(trialEndsAtMs: number): Record<TrialMilestone, number> {
  const startedAtMs = trialEndsAtMs - TRIAL_LENGTH_DAYS * MS_PER_DAY;
  return {
    day10: startedAtMs + TRIAL_REMINDER_DAY.day10 * MS_PER_DAY,
    day13: startedAtMs + TRIAL_REMINDER_DAY.day13 * MS_PER_DAY,
    expired: trialEndsAtMs,
  };
}

/** Readable `trialEndsAt`, or `null` for the pre-go-live sentinel / a corrupt value. */
function trialEndsAtMillis(customer: TrialLifecycleCustomer | null | undefined): number | null {
  const raw = customer?.trialEndsAt;
  if (raw == null) return null;
  return billingTimestampToMillis(raw);
}

function isStamped(customer: TrialLifecycleCustomer | null | undefined, m: TrialMilestone): boolean {
  const markers = customer?.trialEmails;
  if (!markers) return false;
  return markers[TRIAL_MILESTONE_FIELD[m] as keyof TrialEmailMarkers] != null;
}

/**
 * True when this account has been trial-expired for longer than the
 * post-expiry alert grace — i.e. its offline alerts should now be off.
 *
 * Deliberately anchored on `'expired'` only, never `'canceled'`: a
 * subscriber who cancels has no meaningful `trialEndsAt` (it is typically
 * long past), so measuring their grace from it would cut their alerts the
 * instant they cancel. The cancel path gets its own anchor when wave 2 lands
 * subscription lifecycle; until then a canceled account keeps its alerts.
 */
export function alertGraceElapsed(
  customer: TrialLifecycleCustomer | null | undefined,
  now: Date = new Date(),
): boolean {
  if (resolveBillingState(customer, now) !== 'expired') return false;
  const endsAtMs = trialEndsAtMillis(customer);
  if (endsAtMs === null) return false;
  return now.getTime() >= endsAtMs + POST_EXPIRY_ALERT_GRACE_DAYS * MS_PER_DAY;
}

/**
 * THE read the alert pipeline consults before emailing an account's admins.
 *
 * Two conditions, both required. The **flag** is the primary signal, so the
 * suppression is auditable from the document itself and costs the caller one
 * read. The **state re-check** exists because the flag is only rewritten by
 * a daily cron: an account that converts (or gets its trial extended) at
 * 09:00 must get its alerts back at 09:00, not whenever the sweep next runs.
 * A stale flag is therefore inert rather than a silent day-long alert outage.
 */
export function alertEmailsDisabled(
  customer: TrialLifecycleCustomer | null | undefined,
  now: Date = new Date(),
): boolean {
  if (customer?.alertEmailsDisabledAt == null) return false;
  return resolveBillingState(customer, now) === 'expired';
}

/**
 * Decide everything this run owes a single account. Pure — no clock of its
 * own, no I/O — so the whole milestone matrix is testable directly.
 */
export function planTrialLifecycle(
  customer: TrialLifecycleCustomer | null | undefined,
  now: Date,
): TrialLifecyclePlan {
  const billingState = resolveBillingState(customer, now);
  const writeBillingState = customer?.billingState !== billingState;

  const nowMs = now.getTime();
  const endsAtMs = trialEndsAtMillis(customer);

  // Milestones only exist on the trial path. `'active'` / `'canceled'` come
  // exclusively from the subscription branch of the resolver, and a null
  // `trialEndsAt` is the pre-go-live sentinel.
  const onTrialClock = billingState === 'trialing' || billingState === 'expired';

  let sendMilestone: TrialMilestone | null = null;
  let settleMilestones: TrialMilestone[] = [];

  if (onTrialClock && endsAtMs !== null) {
    const instants = trialMilestoneInstants(endsAtMs);
    const due = MILESTONE_ORDER.filter((m) => nowMs >= instants[m]);
    const target = due[due.length - 1];
    // Only the latest due milestone can be sent, and only if it hasn't been.
    // An earlier unstamped milestone never resurrects a stale notice — it is
    // settled alongside the target instead.
    if (target !== undefined && !isStamped(customer, target)) {
      sendMilestone = target;
      settleMilestones = due.filter((m) => !isStamped(customer, m));
    }
  }

  return {
    billingState,
    writeBillingState,
    sendMilestone,
    trialEndsAt: endsAtMs === null ? null : new Date(endsAtMs),
    settleMilestones,
    alertCutoff: planAlertCutoff(customer, now),
  };
}

/**
 * Keep the stored `alertEmailsDisabledAt` marker in step with whether the
 * grace has actually elapsed.
 *
 * The `'clear'` arm is the one that matters: without it, an account that
 * converts (or gets its trial extended by an admin) keeps a marker that reads
 * as "alerts off" to anyone inspecting the record, and re-arms instantly if
 * they ever lapse again — skipping the 30 days they are owed.
 */
function planAlertCutoff(
  customer: TrialLifecycleCustomer | null | undefined,
  now: Date,
): AlertCutoffAction {
  const flagSet = customer?.alertEmailsDisabledAt != null;
  if (alertGraceElapsed(customer, now)) return flagSet ? 'none' : 'set';
  return flagSet ? 'clear' : 'none';
}

/* ─── running the sweep ────────────────────────────────────────────────── */

/** Injectable transport so tests never touch Resend. */
export type TrialEmailSender = (message: {
  to: string;
  subject: string;
  html: string;
}) => Promise<void>;

export interface TrialLifecycleSummary {
  /** customers docs read this run. */
  processed: number;
  /** accounts flipped TO `'expired'` this run (not the total already expired). */
  expired: number;
  emailsSent: Record<TrialMilestone, number>;
  /** accounts whose `alertEmailsDisabledAt` was stamped this run. */
  alertCutoffs: number;
  /** docs that failed and were skipped. A non-zero value never aborts the run. */
  errors: number;
}

export interface TrialLifecycleOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
  /** Inject a transport; production falls back to Resend. */
  sendEmail?: TrialEmailSender;
}

/**
 * Customers read per query. The sweep touches every account once a day, so
 * the page size trades round-trips against the memory held for one page —
 * not a write-batch size (each account commits its own merge).
 */
const CUSTOMER_PAGE_SIZE = 300;

/**
 * Public origin for the dashboard deep-link.
 *
 * Same derivation as `emailTemplates.server.ts` and the billing portal: the
 * configured origin, never a request header. A cron request carries no
 * trustworthy Host, and the link ships to a customer's inbox.
 */
function choosePlanUrl(): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');
  return `${baseUrl}/dashboard?${CHOOSE_PLAN_QUERY}`;
}

/** Resend-backed sender, or `null` when the deployment has no mail transport. */
function resendSender(): TrialEmailSender | null {
  const client = getResend();
  if (!client) return null;
  return async ({ to, subject, html }) => {
    const result = await client.emails.send({ from: FROM_EMAIL, to: [to], subject, html });
    if (result.error) throw new Error(String(result.error.message ?? 'resend rejected the message'));
  };
}

/**
 * Recipient for an account's trial mail: the owning user's address, or
 * `null` when there is nobody to write to (missing user doc, no email, or a
 * soft-deleted account — mailing a deleted user about their trial would be
 * both useless and a privacy problem).
 */
async function trialRecipient(db: Firestore, uid: string): Promise<string | null> {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return null;
  const userData = userSnap.data() ?? {};
  if (typeof userData.deletedAt === 'number') return null;
  const email = userData.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

/**
 * Sweep every customers doc once.
 *
 * Partial-failure tolerant by construction: each account is processed inside
 * its own try/catch, so a malformed doc, a missing user, or a rejected send
 * costs exactly that account and is counted in `errors`. Only a failure to
 * *page the collection* aborts, and that propagates to the route's 500.
 *
 * Ordering within an account: email first, markers second. A marker records
 * that the notice was sent, so writing it ahead of a send that then fails
 * would silently burn the milestone forever. The inverse risk — a send that
 * succeeds and a marker write that fails — costs one duplicate email on the
 * next run, which is the cheaper of the two wrong answers.
 */
export async function runTrialLifecycle(
  options: TrialLifecycleOptions = {},
): Promise<TrialLifecycleSummary> {
  const db = options.db ?? getAdminDb();
  const now = options.now ?? new Date();

  const sendEmail = options.sendEmail ?? resendSender();
  if (!sendEmail) {
    // Not an error: a deployment without RESEND_API_KEY still needs its
    // billing states mirrored. Milestones stay unstamped and retry once mail
    // is configured, so nothing is lost — just deferred.
    console.warn(`${LOG} resend not configured — trial emails skipped this run`);
  }

  const planUrl = choosePlanUrl();
  const summary: TrialLifecycleSummary = {
    processed: 0,
    expired: 0,
    emailsSent: { day10: 0, day13: 0, expired: 0 },
    alertCutoffs: 0,
    errors: 0,
  };

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (;;) {
    let query: FirebaseFirestore.Query = db
      .collection('customers')
      .orderBy(FieldPath.documentId())
      .limit(CUSTOMER_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      summary.processed += 1;
      try {
        await processCustomer(db, doc, now, planUrl, sendEmail, summary);
      } catch (error) {
        summary.errors += 1;
        // Uid only — never the customer's email address or any Stripe id.
        console.error(`${LOG} failed for customers/${doc.id}:`, error);
      }
    }

    if (page.size < CUSTOMER_PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }

  return summary;
}

/**
 * Apply one account's plan. Extracted so the paging loop stays readable and
 * every throw inside it lands on the same per-doc catch.
 */
async function processCustomer(
  db: Firestore,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: Date,
  planUrl: string,
  sendEmail: TrialEmailSender | null,
  summary: TrialLifecycleSummary,
): Promise<void> {
  const customer = (doc.data() ?? {}) as TrialLifecycleCustomer;
  const plan = planTrialLifecycle(customer, now);

  const update: Record<string, unknown> = {};

  if (plan.writeBillingState) {
    update.billingState = plan.billingState;
  }

  if (plan.alertCutoff === 'set') {
    update.alertEmailsDisabledAt = FieldValue.serverTimestamp();
  } else if (plan.alertCutoff === 'clear') {
    update.alertEmailsDisabledAt = FieldValue.delete();
  }

  // --- milestone email ---------------------------------------------------
  // Attempted before the doc write so its markers ride along in the same
  // merge; a send failure simply leaves them out and retries next run.
  if (plan.sendMilestone && plan.trialEndsAt && sendEmail) {
    const to = await trialRecipient(db, doc.id);
    if (to === null) {
      // No deliverable address. Counted so an account stuck in this state is
      // visible in the run summary rather than silently never notified.
      summary.errors += 1;
      console.warn(`${LOG} no recipient for customers/${doc.id} — trial email skipped`);
    } else {
      const { subject, html } = buildTrialEmail(plan.sendMilestone, plan.trialEndsAt, planUrl);
      await sendEmail({ to, subject, html });
      summary.emailsSent[plan.sendMilestone] += 1;
      const markers: Record<string, unknown> = {};
      for (const milestone of plan.settleMilestones) {
        markers[TRIAL_MILESTONE_FIELD[milestone]] = FieldValue.serverTimestamp();
      }
      update.trialEmails = markers;
    }
  }

  if (Object.keys(update).length === 0) return;

  // merge:true deep-merges `trialEmails`, so stamping one milestone leaves
  // its siblings intact.
  await doc.ref.set(update, { merge: true });

  if (plan.writeBillingState && plan.billingState === 'expired') summary.expired += 1;
  if (plan.alertCutoff === 'set') summary.alertCutoffs += 1;
}
