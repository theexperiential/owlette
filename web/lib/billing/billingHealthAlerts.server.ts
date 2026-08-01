/**
 * Subscription health alerts (billing-system wave 4.3).
 *
 * Emails the two audiences who need to know when a paying account goes
 * wrong: the **account owner** (calm, customer-facing, tells them what still
 * works and how to fix it) and the **superadmin ops address** (identifiers,
 * so the alert can be triaged against Stripe).
 *
 * Three kinds, each raised from exactly one place in
 * `stripeEventHandlers.ts`:
 *
 * | kind                    | raised by                                                   |
 * |-------------------------|-------------------------------------------------------------|
 * | `subscription_canceled` | `customer.subscription.deleted`                             |
 * | `payment_failed`        | `invoice.payment_failed`                                    |
 * | `past_due`              | a subscription event that moves the stored status INTO `past_due` |
 *
 * ## why `past_due` is transition-only
 *
 * Stripe re-sends `customer.subscription.updated` throughout dunning, and
 * every one of those payloads carries `status: past_due`. Alerting on the
 * *value* would mail the customer on each retry; alerting on the *edge* —
 * stored status was not `past_due`, incoming is — mails them once when the
 * account actually changes state. The 24h cooldown below is the second
 * belt: the edge check answers "is this news?", the cooldown answers "have
 * we already said it?".
 *
 * A single failed renewal can legitimately produce two emails of *different
 * kinds*: `invoice.payment_failed` and the `customer.subscription.updated`
 * that flips the status both arrive, and which one lands first decides
 * whether the second still sees an edge. That is intended — they say
 * different things ("the charge was declined" vs "the account is now
 * overdue") — and each kind carries its own cooldown, so neither can repeat.
 *
 * ## the state the ops copy reports
 *
 * Read off `customers/{uid}` at the moment the alert runs — the same read
 * that answers the cooldown — rather than passed in by the caller. The
 * subscription handler raises its alert *after* the mirror write, so ops
 * sees the post-event state. The invoice handler raises `payment_failed`
 * *before* the `active → past_due` promotion, so ops sees `active` alongside
 * an `invoice.payment_failed` event type, which is the accurate reading of
 * "a charge just failed on a live subscription".
 *
 * ## ordering: send, then stamp
 *
 * Same posture as the trial lifecycle sweep: the cooldown marker records
 * that an email *went out*, so writing it before the send would silently
 * burn the alert for 24h whenever the mail transport is having a bad day.
 * The inverse risk — a send that lands and a marker write that fails — costs
 * one duplicate on the next event, which is the cheaper wrong answer.
 *
 * ## never throws
 *
 * Every path is wrapped. An alert is a courtesy on top of event processing;
 * a Resend outage or a malformed user doc must never turn a Stripe webhook
 * into a 500, because Stripe would then retry an event we already applied.
 *
 * Logs carry the uid, kind and outcome — never the recipient's address, never
 * the Stripe payload.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  billingTimestampToMillis,
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import type { BillingTimestamp } from '@/lib/types/customer';
import { FROM_EMAIL, getResend, isProduction } from '@/lib/resendClient.server';
import {
  buildBillingHealthOpsEmail,
  buildBillingHealthOwnerEmail,
  BILLING_HEALTH_LABEL,
  CHOOSE_PLAN_QUERY,
  type BillingHealthEmailKind,
} from '@/lib/emailTemplates.server';

const LOG = '[billing-health-alert]';

/**
 * The three health events. Aliased from the email module's union so the copy
 * and the sender can never drift apart — see `BillingHealthEmailKind`.
 */
export type BillingHealthAlertKind = BillingHealthEmailKind;

/** Map field on `customers/{uid}` holding the per-kind send markers. */
export const HEALTH_ALERTS_FIELD = 'healthAlerts';

/**
 * Minimum gap between two alerts of the same kind for the same account.
 *
 * 24h, per the task's "cooldown prevents repeat alerts within 24h for the
 * same event type per customer". Scoped per kind rather than per account so
 * a cancellation is never swallowed by a payment failure that preceded it.
 */
export const HEALTH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Per-kind send markers as stored under `customers/{uid}.healthAlerts`. */
export type BillingHealthAlertMarkers = Partial<
  Record<BillingHealthAlertKind, BillingTimestamp | null>
>;

/**
 * Everything the alert needs that only the webhook handler knows.
 *
 * Deliberately does *not* carry the account's billing state: this module
 * already reads `customers/{uid}` for the cooldown marker, so it resolves
 * the state from that same read. Passing it in would add a parameter every
 * call site could get out of step with the document, for no extra read.
 */
export interface BillingHealthAlertContext {
  /** Injected Firestore — the handler already has one; this module never mints its own. */
  db: Firestore;
  /** The handler's clock, so the cooldown and the copy agree with the event. */
  now: Date;
  /** Stripe event id, quoted in the ops copy. */
  eventId: string;
  /** Stripe event type that produced the alert. */
  eventType: string;
  /** Stripe subscription or invoice id the event carried. */
  objectId?: string | null;
}

/**
 * What one call did.
 *
 * - `sent` — at least one message left the building; the marker was stamped.
 * - `cooldown` — an alert of this kind went out for this account inside the window.
 * - `no_transport` — Resend is unconfigured on this deployment.
 * - `no_recipients` — neither the owner nor the ops address is deliverable.
 * - `failed` — every send (or the Firestore read) threw; nothing was stamped.
 */
export type BillingHealthAlertOutcome =
  | 'sent'
  | 'cooldown'
  | 'no_transport'
  | 'no_recipients'
  | 'failed';

export interface BillingHealthAlertResult {
  outcome: BillingHealthAlertOutcome;
  /** How many messages actually went out (0–2). */
  sent: number;
}

/** Injectable transport shape, mirroring `TrialEmailSender`. */
type HealthAlertSender = (message: {
  to: string;
  subject: string;
  html: string;
}) => Promise<void>;

/** Resend-backed sender, or `null` when the deployment has no mail transport. */
function resendSender(): HealthAlertSender | null {
  const client = getResend();
  if (!client) return null;
  return async ({ to, subject, html }) => {
    const result = await client.emails.send({ from: FROM_EMAIL, to: [to], subject, html });
    if (result.error) throw new Error(String(result.error.message ?? 'resend rejected the message'));
  };
}

/**
 * The superadmin ops address.
 *
 * `ADMIN_EMAIL_PROD` / `ADMIN_EMAIL_DEV` selected by `isProduction` — the
 * convention every other ops notification in the codebase already uses
 * (`/api/webhooks/user-created`, `/api/bug-report`, and the orphan-site
 * fallback in `adminUtils.server.ts`). There is no `role == 'superadmin'`
 * recipient query anywhere in the repo, so introducing one here would have
 * been a second, divergent convention.
 *
 * Read per call rather than at module load so a deployment that sets the var
 * after boot (and every test) sees the current value.
 */
function opsRecipient(): string | null {
  const email = isProduction ? process.env.ADMIN_EMAIL_PROD : process.env.ADMIN_EMAIL_DEV;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

/**
 * Recipient for the account owner's copy: the owning user's address, or
 * `null` when there is nobody to write to (missing user doc, no email, or a
 * soft-deleted account). Mirrors `trialRecipient()` in the trial sweep —
 * mailing a deleted user about their subscription would be both useless and
 * a privacy problem.
 */
async function ownerRecipient(db: Firestore, uid: string): Promise<string | null> {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (typeof data.deletedAt === 'number') return null;
  const email = data.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

/**
 * Public origin for the customer's deep-link.
 *
 * Same derivation as `emailTemplates.server.ts`, the trial sweep, and the
 * billing portal's return url: the configured origin, never a request
 * header. A webhook request carries no trustworthy Host, and this link ships
 * to a customer's inbox.
 */
function ownerActionUrl(kind: BillingHealthAlertKind): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app');

  // A canceled account reactivates through the tier picker, which is exactly
  // what `CHOOSE_PLAN_QUERY` opens. A past-due or failed-payment account
  // already has a plan — sending them to "choose a plan" would be wrong, so
  // they get the dashboard and the copy names the billing settings path.
  return kind === 'subscription_canceled'
    ? `${baseUrl}/dashboard?${CHOOSE_PLAN_QUERY}`
    : `${baseUrl}/dashboard`;
}

/**
 * True when an alert of this kind was sent for this account inside the
 * cooldown window. An unreadable marker counts as "not sent" — the same
 * fail-open posture the rest of the billing code takes on corrupt
 * timestamps, because suppressing a cancellation notice over our own data
 * bug is the worse failure.
 */
function withinCooldown(
  markers: BillingHealthAlertMarkers | null | undefined,
  kind: BillingHealthAlertKind,
  now: Date,
): boolean {
  const raw = markers?.[kind];
  if (raw == null) return false;
  const lastSentMs = billingTimestampToMillis(raw);
  if (lastSentMs === null) return false;
  return now.getTime() - lastSentMs < HEALTH_ALERT_COOLDOWN_MS;
}

/**
 * Send one message, reporting success rather than throwing. A failed send to
 * one audience must not cost the other its copy.
 */
async function trySend(
  send: HealthAlertSender,
  message: { to: string; subject: string; html: string },
  audience: 'owner' | 'ops',
  uid: string,
  kind: BillingHealthAlertKind,
): Promise<boolean> {
  try {
    await send(message);
    return true;
  } catch (error) {
    // uid + audience only — never the address we tried to reach.
    console.error(`${LOG} ${kind} ${audience} send failed for customers/${uid}:`, error);
    return false;
  }
}

/**
 * Alert both audiences about a subscription health event, unless this
 * account has already been alerted about this kind inside the cooldown.
 *
 * Never throws. Callers in the webhook path await it purely so the sends
 * finish before the serverless invocation is frozen; the returned outcome is
 * for tests and for anyone reading a log.
 */
export async function maybeSendBillingHealthAlert(
  kind: BillingHealthAlertKind,
  uid: string,
  context: BillingHealthAlertContext,
): Promise<BillingHealthAlertResult> {
  const { db, now } = context;

  try {
    const send = resendSender();
    if (!send) {
      // Not an error: a deployment without RESEND_API_KEY still processes
      // billing events correctly, it just cannot tell anyone. Debug level,
      // matching the trial emails' "skipped, not failed" posture.
      console.debug(`${LOG} ${kind} for customers/${uid}: resend not configured — skipped`);
      return { outcome: 'no_transport', sent: 0 };
    }

    const customerRef = db.collection('customers').doc(uid);
    const customerSnap = await customerRef.get();
    const customer = customerSnap.data() ?? {};
    const markers = customer[HEALTH_ALERTS_FIELD] as BillingHealthAlertMarkers | undefined;

    if (withinCooldown(markers, kind, now)) {
      console.log(`${LOG} ${kind} for customers/${uid}: within 24h cooldown — skipped`);
      return { outcome: 'cooldown', sent: 0 };
    }

    const ops = opsRecipient();
    // A failed user lookup costs the owner their copy, not the ops alert.
    const owner = await ownerRecipient(db, uid).catch((error) => {
      console.error(`${LOG} ${kind} owner lookup failed for customers/${uid}:`, error);
      return null;
    });

    if (!owner && !ops) {
      console.warn(`${LOG} ${kind} for customers/${uid}: no deliverable recipient — skipped`);
      return { outcome: 'no_recipients', sent: 0 };
    }

    let sent = 0;

    if (owner) {
      const { subject, html } = buildBillingHealthOwnerEmail(kind, ownerActionUrl(kind));
      if (await trySend(send, { to: owner, subject, html }, 'owner', uid, kind)) sent += 1;
    }

    if (ops) {
      const storedStatus = customer.subscriptionStatus;
      const { subject, html } = buildBillingHealthOpsEmail(kind, {
        uid,
        eventId: context.eventId,
        eventType: context.eventType,
        billingState: resolveBillingState(customer as BillingStateSource, now),
        subscriptionStatus:
          typeof storedStatus === 'string' && storedStatus.length > 0 ? storedStatus : 'none',
        objectId: context.objectId ?? 'none',
        occurredAt: now,
      });
      if (await trySend(send, { to: ops, subject, html }, 'ops', uid, kind)) sent += 1;
    }

    if (sent === 0) return { outcome: 'failed', sent: 0 };

    // Stamped only now, and only because something went out. merge:true
    // deep-merges the map, so stamping one kind leaves its siblings intact —
    // the same pattern as the trial sweep's `trialEmails` markers. A concrete
    // Date rather than a server-timestamp sentinel: this marker is read back
    // for arithmetic, not just presence, and `now` is the same clock the
    // event was applied with.
    await customerRef.set({ [HEALTH_ALERTS_FIELD]: { [kind]: now } }, { merge: true });

    console.log(
      `${LOG} ${BILLING_HEALTH_LABEL[kind]} alerted for customers/${uid} (${sent} message(s), event ${context.eventId})`,
    );
    return { outcome: 'sent', sent };
  } catch (error) {
    // The catch-all that makes the promise this module's header makes: an
    // alert can fail in any way it likes without failing event processing.
    console.error(`${LOG} ${kind} failed for customers/${uid}:`, error);
    return { outcome: 'failed', sent: 0 };
  }
}
