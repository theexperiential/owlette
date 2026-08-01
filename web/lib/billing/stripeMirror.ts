/**
 * Firestore mirror for Stripe webhook events (billing-system wave 1.3).
 *
 * Every Firestore write the webhook handler makes lives here; `stripeEventHandlers`
 * decides *what* a Stripe event means, this module decides *where it lands*.
 * Splitting the two keeps the event-shape knowledge (Stripe's enums, field
 * relocations across API versions) out of the persistence layer and lets the
 * handler tests assert on plain data rather than on Firestore call shapes.
 *
 * Collections written here:
 *
 * ```
 * customers/{uid}                       # the billing mirror (see lib/types/customer.ts)
 * billing/{uid}/invoices/{invoiceId}    # in-app invoice history
 * billing/{uid}/stripe_events/{eventId} # idempotency ledger
 * stripe_events/{eventId}               # idempotency ledger, uid unresolved
 * sites/{siteId}                        # tier + tierUpgradedAt at conversion
 * ```
 *
 * `billing/{uid}` itself is never written — Firestore subcollections do not
 * require a parent document to exist, and minting an empty placeholder would
 * only add a doc nobody reads.
 *
 * None of these collections appear in `firestore.rules`, so they are
 * default-deny to every client. All access is Admin-SDK, server-side only.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import type { SiteTier } from '@/lib/siteTier';
import type { BillingState, SubscriptionStatus } from '@/lib/types/customer';

/** Collection holding the idempotency ledger when the uid could not be resolved. */
export const ORPHAN_EVENTS_COLLECTION = 'stripe_events';

/**
 * Outcome recorded on a processed event marker. Kept on the ledger doc so an
 * operator debugging a customer can see what each replayed event actually did
 * without re-deriving it from the Stripe dashboard.
 */
export type StripeEventOutcome =
  | 'processed'
  | 'duplicate'
  | 'unknown_customer'
  | 'ignored';

/**
 * Partial update applied to `customers/{uid}`. Every key is optional and only
 * *present* keys are written — an absent key leaves the stored value alone,
 * which is what makes `customer.updated` (payment method only) and
 * `customer.subscription.updated` (status/tier/period) composable against the
 * same document without either clobbering the other's fields.
 */
export interface CustomerBillingPatch {
  stripeCustomerId?: string;
  subscriptionId?: string | null;
  subscriptionStatus?: SubscriptionStatus | null;
  subscriptionTier?: SiteTier;
  currentPeriodEnd?: Date | null;
  defaultPaymentMethod?: string | null;
}

/** Fields mirrored from a Stripe invoice into `billing/{uid}/invoices/{id}`. */
export interface InvoiceMirror {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  subtotal: number;
  total: number;
  billingReason: string | null;
  collectionMethod: string | null;
  attemptCount: number;
  created: Date;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date | null;
  finalizedAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  subscriptionId: string | null;
  stripeCustomerId: string | null;
}

/**
 * Reference to the idempotency ledger doc for `eventId`.
 *
 * Filed under the customer when we know who they are so the ledger is
 * co-located with the rest of their billing history and inherits the same
 * per-customer deletion story; otherwise under a top-level collection, which
 * still gives replay protection for events we could not attribute.
 */
function eventRef(db: Firestore, uid: string | null, eventId: string) {
  return uid
    ? db.collection('billing').doc(uid).collection('stripe_events').doc(eventId)
    : db.collection(ORPHAN_EVENTS_COLLECTION).doc(eventId);
}

/**
 * Atomically claim an event id, returning `false` when it was already claimed.
 *
 * `create()` rather than a read-then-write: it fails server-side with
 * ALREADY_EXISTS, so two of Stripe's concurrent retries cannot both pass the
 * check. That is the whole idempotency guarantee — a read-then-write has a
 * window where both callers see "absent".
 *
 * Claim-before-process (rather than mark-after-process) is deliberate: it
 * makes concurrent retries mutually exclusive. The cost is a crash window — if
 * the process dies between the claim and the work, the retry short-circuits on
 * the orphaned claim and that single event is dropped. {@link releaseStripeEvent}
 * closes the window for *thrown* errors, and the residual crash case
 * self-heals because every handler here writes converged current state rather
 * than a delta: the next subscription or invoice event for the same customer
 * restores the mirror.
 */
export async function claimStripeEvent(
  db: Firestore,
  uid: string | null,
  event: { id: string; type: string; created: number },
): Promise<boolean> {
  try {
    await eventRef(db, uid, event.id).create({
      eventId: event.id,
      type: event.type,
      // Stripe's own creation time, so out-of-order delivery is diagnosable.
      stripeCreatedAt: new Date(event.created * 1000),
      receivedAt: FieldValue.serverTimestamp(),
      outcome: 'processing',
    });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

/**
 * Firestore surfaces a failed `create()` as gRPC code 6 (ALREADY_EXISTS).
 * Matched on the numeric code first — the message text is not a contract —
 * with a string fallback for fakes and emulator builds that only set one.
 */
function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 6 || e.code === 'already-exists') return true;
  return typeof e.message === 'string' && e.message.includes('ALREADY_EXISTS');
}

/**
 * Drop a claim so Stripe's next retry can re-run the event.
 *
 * Best-effort by design: it runs on the failure path, and a failure to clean
 * up must not mask the original error. A leaked claim degrades to the same
 * self-healing case described on {@link claimStripeEvent}.
 */
export async function releaseStripeEvent(
  db: Firestore,
  uid: string | null,
  eventId: string,
): Promise<void> {
  try {
    await eventRef(db, uid, eventId).delete();
  } catch {
    // swallowed on purpose — see the doc comment
  }
}

/** Close out a claimed event with its outcome. */
export async function markStripeEventProcessed(
  db: Firestore,
  uid: string | null,
  eventId: string,
  outcome: StripeEventOutcome,
): Promise<void> {
  await eventRef(db, uid, eventId).update({
    outcome,
    processedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Apply `patch` to `customers/{uid}` and recompute the cached `billingState`.
 *
 * Transactional because `billingState` is derived from the *merged* document:
 * the incoming `subscriptionStatus` plus the stored `trialEndsAt`. Without the
 * transaction, a `customer.updated` (which carries no status) could read the
 * pre-change status, be overtaken by a `customer.subscription.updated`, and
 * then write the stale `billingState` back over the fresh one.
 *
 * A missing document is created rather than skipped. That only happens when the
 * uid came from the Stripe customer's `metadata.uid` and the paired customers
 * doc was never minted; writing the mirror is the repair. Fields this patch
 * does not name (`trialEndsAt`, `taxId`, …) stay absent, which every consumer
 * already tolerates — `resolveBillingState()` reads an absent `trialEndsAt` as
 * the documented "clock not started" sentinel.
 *
 * @returns the `billingState` written.
 */
export async function writeCustomerBilling(
  db: Firestore,
  uid: string,
  patch: CustomerBillingPatch,
  now: Date,
): Promise<BillingState> {
  const ref = db.collection('customers').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = (snap.exists ? snap.data() : undefined) as
      | BillingStateSource
      | undefined;

    const billingState = resolveBillingState({ ...existing, ...patch }, now);
    tx.set(ref, { ...patch, billingState }, { merge: true });
    return billingState;
  });
}

/** Mirror an invoice into `billing/{uid}/invoices/{invoiceId}`. */
export async function mirrorInvoice(
  db: Firestore,
  uid: string,
  invoice: InvoiceMirror,
): Promise<void> {
  await db
    .collection('billing')
    .doc(uid)
    .collection('invoices')
    .doc(invoice.id)
    // Merged, not replaced: an invoice arrives as `created`, then `finalized`,
    // then `paid`, and each event refines the same document.
    .set({ ...invoice, mirroredAt: FieldValue.serverTimestamp() }, { merge: true });
}

/**
 * Stamp `tier` onto every site owned by `uid` whose stored tier differs.
 *
 * Compares the **raw stored field**, not `getSiteTier()`'s resolved value. A
 * site minted before the `tier` field existed resolves to `'pro'` through
 * `BETA_DEFAULT_TIER`, so a resolved comparison would leave a paying pro
 * customer's sites permanently unstamped and dependent on a fallback that gets
 * deleted at go-live (task 5.3). Conversion is exactly the moment that
 * ambiguity should be written away.
 *
 * @returns the number of site docs updated.
 */
export async function stampSiteTiers(
  db: Firestore,
  uid: string,
  tier: SiteTier,
): Promise<number> {
  const snap = await db.collection('sites').where('owner', '==', uid).get();

  const stale = snap.docs.filter((doc) => {
    const raw = (doc.data() ?? {}).tier;
    return raw !== tier;
  });
  if (stale.length === 0) return 0;

  await Promise.all(
    stale.map((doc) =>
      doc.ref.update({ tier, tierUpgradedAt: FieldValue.serverTimestamp() }),
    ),
  );

  return stale.length;
}

/**
 * Look up the uid whose customers doc carries `stripeCustomerId`.
 *
 * The fallback arm of uid resolution, used when the Stripe object carries no
 * `metadata.uid`. Requires a single-field index, which Firestore provides
 * automatically.
 */
export async function findUidByStripeCustomerId(
  db: Firestore,
  stripeCustomerId: string,
): Promise<string | null> {
  const snap = await db
    .collection('customers')
    .where('stripeCustomerId', '==', stripeCustomerId)
    .limit(1)
    .get();

  return snap.docs[0]?.id ?? null;
}
