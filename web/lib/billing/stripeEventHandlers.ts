/**
 * Stripe webhook event handlers (billing-system wave 1.3).
 *
 * Turns a *verified* Stripe event into Firestore state. Signature verification
 * is the route's job (`app/api/billing/stripe-webhook/route.ts`); by the time
 * anything here runs, the payload is trusted.
 *
 * Two rules shape everything below:
 *
 * 1. **Never 500 on data we cannot repair.** Stripe retries a non-2xx for up to
 *    three days with backoff. An event for a customer we have no record of is
 *    not going to become resolvable by retrying, so it is logged and answered
 *    200 (`unknown_customer`). Genuine faults — Firestore down, a bug — do
 *    throw, because those *are* worth retrying.
 * 2. **Log identifiers, never payloads.** Every log line here carries the event
 *    id and type and nothing else. Stripe payloads contain customer PII and,
 *    in some object shapes, partial payment details.
 *
 * ## status normalisation (the one place it is defined)
 *
 * `Customer.subscriptionStatus` is deliberately narrower than Stripe's enum.
 * The full mapping:
 *
 * | Stripe subscription status | ours          | note                                                        |
 * |----------------------------|---------------|-------------------------------------------------------------|
 * | `active`                   | `active`      |                                                             |
 * | `past_due`                 | `past_due`    | keeps access — Stripe dunning owns recovery                 |
 * | `canceled`                 | `canceled`    | lockout                                                     |
 * | `incomplete_expired`       | `canceled`    | checkout abandoned past Stripe's window — never paid        |
 * | `incomplete`               | `incomplete`  | falls through to the trial clock                            |
 * | `trialing`                 | `active`      | **warns** — we do not use Stripe trials; ours is app-managed |
 * | `unpaid`                   | `past_due`    | **warns** — dunning exhausted but not yet canceled          |
 * | `paused`                   | `past_due`    | **warns** — we never pause; treat as a payment problem       |
 * | anything else              | `incomplete`  | **warns** — see below                                       |
 *
 * The unknown arm maps to `incomplete`, not `canceled`: Stripe's typings carry
 * an `OtherString` escape hatch precisely because new statuses ship without a
 * major version, and inventing a cancellation that never happened would both
 * lock the customer out and lie in the billing UI. `incomplete` is the existing
 * "nothing has been paid for — fall through to the trial clock" bucket, which
 * satisfies the `Customer` type's contract that an unrecognised status must
 * never read as a paid subscription.
 *
 * ## tier mapping
 *
 * Price ids come from env (wave 1.1 creates them in both Stripe modes):
 *
 * | env var                            | tier   |
 * |------------------------------------|--------|
 * | `STRIPE_PRICE_CORE_MACHINE`        | `core` |
 * | `STRIPE_PRICE_PRO_MACHINE`         | `pro`  |
 * | `STRIPE_PRICE_PRO_STORAGE_OVERAGE` | `pro`  |
 *
 * A subscription is resolved from *all* its line items, and `pro` wins: a pro
 * subscription carries both the per-machine price and the storage-overage
 * price, so "any pro price ⇒ pro" is the only reading that survives a
 * multi-item subscription.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';
import type { SiteTier } from '@/lib/siteTier';
import type { SubscriptionStatus } from '@/lib/types/customer';
import {
  claimStripeEvent,
  findUidByStripeCustomerId,
  markStripeEventProcessed,
  mirrorInvoice,
  releaseStripeEvent,
  stampSiteTiers,
  writeCustomerBilling,
  type CustomerBillingPatch,
  type InvoiceMirror,
  type StripeEventOutcome,
} from '@/lib/billing/stripeMirror';

const LOG_PREFIX = '[stripe-webhook]';

/**
 * Events this endpoint acts on. Anything else is answered 200 and ignored — a
 * Stripe endpoint can be subscribed to more types than we handle (by console
 * misconfiguration, or by "send all events"), and that must not be an error.
 */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.updated',
]);

export interface StripeEventResult {
  eventId: string;
  type: string;
  outcome: StripeEventOutcome;
  /** Resolved account uid, or `null` when the customer could not be matched. */
  uid: string | null;
}

export interface HandleStripeEventOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
}

/* ─── normalisation ─────────────────────────────────────────────────────── */

/**
 * Map a Stripe subscription status onto our four. See the table in this
 * module's header for the full rationale; warnings are emitted for every arm
 * that is not a straight rename, because each one means Stripe put the
 * subscription somewhere our model does not expect.
 */
export function normalizeSubscriptionStatus(
  raw: string | null | undefined,
  context: { eventId: string; type: string },
): SubscriptionStatus {
  switch (raw) {
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'trialing':
      warn(context, 'stripe reported a trialing subscription; owlette trials are app-managed — treating as active');
      return 'active';
    case 'unpaid':
    case 'paused':
      warn(context, `stripe subscription status "${raw}" has no owlette equivalent — treating as past_due`);
      return 'past_due';
    default:
      warn(context, `unrecognised stripe subscription status "${raw}" — treating as incomplete (no paid access)`);
      return 'incomplete';
  }
}

/**
 * Resolve the tier a set of price ids represents, or `null` when none of them
 * is configured. `null` is never written to the customer doc — see
 * {@link subscriptionPatch} — because an unrecognised price (an unconfigured
 * env var, or a hand-built enterprise price) must not silently downgrade a
 * paying account.
 */
export function tierForPriceIds(priceIds: readonly string[]): SiteTier | null {
  const core = process.env.STRIPE_PRICE_CORE_MACHINE;
  const proMachine = process.env.STRIPE_PRICE_PRO_MACHINE;
  const proOverage = process.env.STRIPE_PRICE_PRO_STORAGE_OVERAGE;

  const ids = new Set(priceIds);
  // pro wins: a pro subscription carries the machine price *and* the overage
  // price, so the core check must not short-circuit it.
  if ((proMachine && ids.has(proMachine)) || (proOverage && ids.has(proOverage))) {
    return 'pro';
  }
  if (core && ids.has(core)) return 'core';
  return null;
}

/** Price ids on every line item of a subscription. */
function priceIdsOf(subscription: Stripe.Subscription): string[] {
  return (subscription.items?.data ?? [])
    .map((item) => item.price?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * End of the current billing period.
 *
 * Read off the subscription **items**, not the subscription: Stripe moved
 * `current_period_end` onto `SubscriptionItem` in the 2025 API versions, and
 * the top-level field is gone from the typings shipped with stripe@22. The
 * top-level value is still probed first so an account pinned to an older API
 * version keeps working. The max across items is used because items on a
 * multi-price subscription can, in principle, bill on different anchors, and
 * the customer keeps access until the last one lapses.
 */
function currentPeriodEndOf(subscription: Stripe.Subscription): Date | null {
  const legacy = (subscription as unknown as { current_period_end?: unknown })
    .current_period_end;
  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    return new Date(legacy * 1000);
  }

  const ends = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  return ends.length > 0 ? new Date(Math.max(...ends) * 1000) : null;
}

/** Unwrap a Stripe field that is either an id string or an expanded object. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

/** Epoch seconds → `Date`, tolerating Stripe's nullable timestamp fields. */
function secondsToDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000)
    : null;
}

/* ─── uid resolution ────────────────────────────────────────────────────── */

interface ResolvedCustomer {
  uid: string | null;
  stripeCustomerId: string | null;
}

/**
 * Resolve the owlette account behind an event, in order:
 *
 * 1. `metadata.uid` on the event object itself — set on every Stripe customer
 *    by wave 1.2, and on the subscription by checkout (wave 2.1).
 * 2. `metadata.uid` on an expanded `customer` object, when the event happens to
 *    carry one (webhook payloads are unexpanded by default, so this is a
 *    best-effort arm rather than the primary path).
 * 3. `customers` where `stripeCustomerId ==` the event's customer id.
 *
 * Metadata is checked before Firestore purely to save a read on the common
 * path; both arms are equally authoritative, since we are the only writer of
 * `metadata.uid`.
 */
async function resolveCustomer(
  db: Firestore,
  event: Stripe.Event,
): Promise<ResolvedCustomer> {
  const object = event.data.object as {
    object?: string;
    id?: string;
    metadata?: Stripe.Metadata | null;
    customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null;
  };

  // `customer.updated` delivers the customer itself; everything else carries a
  // `customer` pointer.
  const isCustomerObject = object.object === 'customer';
  const stripeCustomerId = isCustomerObject
    ? (typeof object.id === 'string' ? object.id : null)
    : idOf(object.customer as string | { id: string } | null | undefined);

  const fromObjectMetadata = readUid(object.metadata);
  if (fromObjectMetadata) return { uid: fromObjectMetadata, stripeCustomerId };

  if (!isCustomerObject && object.customer && typeof object.customer === 'object') {
    const expanded = readUid((object.customer as Stripe.Customer).metadata);
    if (expanded) return { uid: expanded, stripeCustomerId };
  }

  if (!stripeCustomerId) return { uid: null, stripeCustomerId: null };

  const uid = await findUidByStripeCustomerId(db, stripeCustomerId);
  return { uid, stripeCustomerId };
}

function readUid(metadata: Stripe.Metadata | null | undefined): string | null {
  const uid = metadata?.uid;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}

/* ─── logging ───────────────────────────────────────────────────────────── */

interface LogContext {
  eventId: string;
  type: string;
}

/**
 * Event id and type only. Never the payload, the signature, or the signing
 * secret — see the module header.
 */
function warn(ctx: LogContext, message: string): void {
  console.warn(`${LOG_PREFIX} ${ctx.type} ${ctx.eventId}: ${message}`);
}

function info(ctx: LogContext, message: string): void {
  console.log(`${LOG_PREFIX} ${ctx.type} ${ctx.eventId}: ${message}`);
}

/* ─── per-event handling ────────────────────────────────────────────────── */

/** Statuses under which a subscription entitles the account to its tier. */
function isEntitled(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'past_due';
}

/** Customer-doc patch derived from a subscription object. */
function subscriptionPatch(
  subscription: Stripe.Subscription,
  status: SubscriptionStatus,
  ctx: LogContext,
): { patch: CustomerBillingPatch; tier: SiteTier | null } {
  const tier = tierForPriceIds(priceIdsOf(subscription));
  if (!tier) {
    warn(ctx, 'no configured price id on the subscription — leaving subscriptionTier unchanged');
  }

  const patch: CustomerBillingPatch = {
    subscriptionId: subscription.id,
    subscriptionStatus: status,
    currentPeriodEnd: currentPeriodEndOf(subscription),
    ...(tier ? { subscriptionTier: tier } : {}),
  };

  const stripeCustomerId = idOf(
    subscription.customer as string | { id: string } | null | undefined,
  );
  if (stripeCustomerId) patch.stripeCustomerId = stripeCustomerId;

  return { patch, tier };
}

/**
 * `customer.subscription.created` / `.updated` / `.deleted`.
 *
 * On an entitled status the account's sites are stamped with the subscription's
 * tier. On cancellation the site tier fields are deliberately left alone — the
 * lockout comes from `billingState`, and rewriting tiers on cancel would both
 * lose the record of what the customer had and make reactivation a second
 * migration.
 */
async function handleSubscriptionEvent(
  db: Firestore,
  uid: string,
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  now: Date,
  ctx: LogContext,
): Promise<void> {
  const deleted = event.type === 'customer.subscription.deleted';
  const status = deleted
    ? 'canceled'
    : normalizeSubscriptionStatus(subscription.status, ctx);

  const { patch, tier } = subscriptionPatch(subscription, status, ctx);
  const billingState = await writeCustomerBilling(db, uid, patch, now);

  if (deleted || !isEntitled(status)) {
    info(ctx, `status=${status} billingState=${billingState} (site tiers untouched)`);
    return;
  }

  const stamped = tier ? await stampSiteTiers(db, uid, tier) : 0;
  info(
    ctx,
    `status=${status} billingState=${billingState} tier=${tier ?? 'unchanged'} sitesStamped=${stamped}`,
  );
}

/** Project a Stripe invoice onto the fields we mirror. */
function toInvoiceMirror(invoice: Stripe.Invoice): InvoiceMirror {
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    currency: invoice.currency,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    amountRemaining: invoice.amount_remaining,
    subtotal: invoice.subtotal,
    total: invoice.total,
    billingReason: invoice.billing_reason ?? null,
    collectionMethod: invoice.collection_method ?? null,
    attemptCount: invoice.attempt_count,
    created: new Date(invoice.created * 1000),
    periodStart: new Date(invoice.period_start * 1000),
    periodEnd: new Date(invoice.period_end * 1000),
    dueDate: secondsToDate(invoice.due_date),
    finalizedAt: secondsToDate(invoice.status_transitions?.finalized_at),
    paidAt: secondsToDate(invoice.status_transitions?.paid_at),
    voidedAt: secondsToDate(invoice.status_transitions?.voided_at),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
    subscriptionId: invoiceSubscriptionId(invoice),
    stripeCustomerId: idOf(
      invoice.customer as string | { id: string } | null | undefined,
    ),
  };
}

/**
 * The subscription that generated an invoice.
 *
 * Stripe moved this from `invoice.subscription` to
 * `invoice.parent.subscription_details.subscription` in the 2025 API versions;
 * the legacy location is probed as a fallback for accounts pinned to an older
 * version.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  const parentId = idOf(fromParent as string | { id: string } | null | undefined);
  if (parentId) return parentId;

  const legacy = (invoice as unknown as { subscription?: unknown }).subscription;
  return idOf(legacy as string | { id: string } | null | undefined);
}

/**
 * `invoice.created` / `.finalized` / `.paid` / `.payment_failed`.
 *
 * The mirror is written for all four. Subscription **status** is otherwise
 * owned exclusively by `customer.subscription.*` events — Stripe's subscription
 * object is the authority, and it always emits a `.updated` when a status
 * changes. The single exception is a failed renewal, which is reflected
 * immediately so the account is marked `past_due` without waiting on delivery
 * order.
 *
 * That exception is narrowed to subscriptions we already believe are good
 * (`active`). A first-invoice failure leaves the subscription `incomplete` in
 * Stripe, and promoting `incomplete` → `past_due` would be an entitlement bug,
 * not a status update: `resolveBillingState()` reads `past_due` as `'active'`,
 * so it would hand full access to a subscription that never paid.
 */
async function handleInvoiceEvent(
  db: Firestore,
  uid: string,
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  now: Date,
  ctx: LogContext,
): Promise<void> {
  const mirror = toInvoiceMirror(invoice);
  await mirrorInvoice(db, uid, mirror);

  if (event.type !== 'invoice.payment_failed' || !mirror.subscriptionId) {
    info(ctx, `invoice ${mirror.id} mirrored (status=${mirror.status ?? 'none'})`);
    return;
  }

  const current = await readSubscriptionStatus(db, uid);
  if (current !== 'active') {
    warn(
      ctx,
      `renewal failed but stored subscriptionStatus is "${current ?? 'none'}" — mirroring only`,
    );
    return;
  }

  const billingState = await writeCustomerBilling(
    db,
    uid,
    { subscriptionStatus: 'past_due' },
    now,
  );
  info(ctx, `invoice ${mirror.id} mirrored; subscription marked past_due (billingState=${billingState})`);
}

/** The stored `subscriptionStatus`, or `null` when absent/unrecognised. */
async function readSubscriptionStatus(
  db: Firestore,
  uid: string,
): Promise<SubscriptionStatus | null> {
  const snap = await db.collection('customers').doc(uid).get();
  const raw = snap.exists ? (snap.data() ?? {}).subscriptionStatus : undefined;
  return raw === 'active' || raw === 'past_due' || raw === 'canceled' || raw === 'incomplete'
    ? raw
    : null;
}

/**
 * `customer.updated`.
 *
 * Only the default payment method is mirrored. `taxId` is left alone on
 * purpose: Stripe keeps tax ids in a separate `tax_ids` list resource that is
 * not part of the customer object on a webhook payload, so reading it off this
 * event would only ever write `null` over a real value.
 */
async function handleCustomerUpdated(
  db: Firestore,
  uid: string,
  customer: Stripe.Customer,
  now: Date,
  ctx: LogContext,
): Promise<void> {
  const patch: CustomerBillingPatch = {
    stripeCustomerId: customer.id,
    defaultPaymentMethod: idOf(
      customer.invoice_settings?.default_payment_method as
        | string
        | { id: string }
        | null
        | undefined,
    ),
  };

  const billingState = await writeCustomerBilling(db, uid, patch, now);
  info(ctx, `customer mirrored (billingState=${billingState})`);
}

/* ─── entry point ───────────────────────────────────────────────────────── */

/**
 * Apply a verified Stripe event.
 *
 * Never throws for "we cannot attribute this event" — that returns
 * `unknown_customer` and the route answers 200. It *does* throw on
 * infrastructure faults, which the route turns into a 500 so Stripe retries.
 *
 * Replay-safe: the event id is claimed before any work, and released again if
 * the work throws (see `claimStripeEvent`).
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  options: HandleStripeEventOptions = {},
): Promise<StripeEventResult> {
  const ctx: LogContext = { eventId: event.id, type: event.type };
  const base = { eventId: event.id, type: event.type };

  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    // No ledger entry: an unsubscribed type is not something we can replay
    // wrongly, and claiming it would fill the ledger with noise.
    return { ...base, outcome: 'ignored', uid: null };
  }

  // Deferred import keeps `getAdminDb()` out of the module graph for callers
  // that inject a db (every unit test), so the admin SDK is only initialised
  // when a real request needs it.
  const db = options.db ?? (await import('@/lib/firebase-admin')).getAdminDb();
  const now = options.now ?? new Date();

  const { uid, stripeCustomerId } = await resolveCustomer(db, event);

  const claimed = await claimStripeEvent(db, uid, event);
  if (!claimed) {
    info(ctx, 'already processed — replay ignored');
    return { ...base, outcome: 'duplicate', uid };
  }

  let outcome: StripeEventOutcome = 'processed';
  try {
    if (!uid) {
      warn(
        ctx,
        `no owlette account for stripe customer ${stripeCustomerId ?? 'unknown'} — acknowledged without changes`,
      );
      outcome = 'unknown_customer';
    } else {
      await dispatch(db, uid, event, now, ctx);
    }
  } catch (error) {
    await releaseStripeEvent(db, uid, event.id);
    throw error;
  }

  await markStripeEventProcessed(db, uid, event.id, outcome);
  return { ...base, outcome, uid };
}

/** Route a handled event type to its handler. */
async function dispatch(
  db: Firestore,
  uid: string,
  event: Stripe.Event,
  now: Date,
  ctx: LogContext,
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionEvent(db, uid, event, event.data.object, now, ctx);
    case 'invoice.created':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return handleInvoiceEvent(db, uid, event, event.data.object, now, ctx);
    case 'customer.updated':
      return handleCustomerUpdated(db, uid, event.data.object, now, ctx);
    default:
      // Unreachable: HANDLED_EVENT_TYPES gates this switch. Present so adding a
      // type to the set without a case here fails loudly instead of silently
      // acknowledging.
      throw new Error(`${LOG_PREFIX} no handler for ${event.type}`);
  }
}
