/**
 * POST /api/billing/stripe-webhook — Stripe event ingress (billing-system 1.3).
 *
 * Internal, Stripe-facing, and deliberately absent from `openapi.yaml`: it is
 * allow-listed in `scripts/validate-openapi.ts` alongside the other inbound
 * webhooks and cron endpoints.
 *
 * **The signature is the authentication.** There is no session, no api key, and
 * no bearer token — Stripe calls this endpoint, so `stripe-signature` is the
 * only credential that exists. Everything about the verification path therefore
 * fails closed:
 *
 * - no `stripe-signature` header → 400
 * - no signing secret configured  → 400 (never process an unverifiable payload)
 * - signature does not verify     → 400
 *
 * 400 rather than 401/403 on purpose: Stripe does not retry a 4xx, and these
 * three cases are all "this request can never be accepted as-is". A 401 would
 * read as a credential problem the caller could fix by retrying with different
 * auth, which is not the situation.
 *
 * **Raw body.** `constructEvent` recomputes the HMAC over the exact bytes
 * Stripe signed, so the body is read with `req.text()` and never parsed first;
 * a `req.json()` round-trip re-serialises key order and whitespace and breaks
 * verification. `dynamic = 'force-dynamic'` keeps Next from caching or
 * statically evaluating the handler, and `runtime = 'nodejs'` is required
 * because verification uses node's crypto.
 *
 * **Retry semantics.** Anything the handler can act on — including events for
 * customers we cannot match — answers 200, because Stripe retries a non-2xx for
 * up to three days and no amount of retrying repairs missing data. Only genuine
 * faults (Firestore unavailable, a bug) answer 500, which is exactly when a
 * retry helps.
 *
 * Nothing here logs the payload, the signature header, or the signing secret.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe.server';
import { handleStripeEvent } from '@/lib/billing/stripeEventHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOG_PREFIX = '[stripe-webhook]';

/**
 * Signing secret for this deployment.
 *
 * Live first, test as the fallback: production sets `STRIPE_WEBHOOK_SECRET`,
 * while dev and local set only `STRIPE_WEBHOOK_SECRET_TEST`. Ordering it this
 * way means a production deploy cannot silently verify against a test-mode
 * secret if both happen to be present.
 */
function webhookSecret(): string | null {
  return (
    process.env.STRIPE_WEBHOOK_SECRET ||
    process.env.STRIPE_WEBHOOK_SECRET_TEST ||
    null
  );
}

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    console.warn(`${LOG_PREFIX} rejected: missing stripe-signature header`);
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const secret = webhookSecret();
  if (!secret) {
    console.error(
      `${LOG_PREFIX} rejected: no STRIPE_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET_TEST configured`,
    );
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 400 });
  }

  // Raw bytes, before any parsing — the signature covers these exactly.
  const rawBody = await request.text();

  // Acquired separately from the verification below so an unconfigured SDK is
  // not misreported as a bad signature. This one is a 500, not a 400: a missing
  // STRIPE_SECRET_KEY is our deploy bug, and Stripe's retries hold the event
  // until it is fixed rather than discarding it.
  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch (error) {
    console.error(
      `${LOG_PREFIX} stripe sdk unavailable — ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    // The message is Stripe's own ("No signatures found matching the expected
    // signature…"); it contains no secret material. The payload is not logged.
    console.warn(
      `${LOG_PREFIX} rejected: signature verification failed — ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event);
    return NextResponse.json({
      received: true,
      eventId: result.eventId,
      type: result.type,
      outcome: result.outcome,
    });
  } catch (error) {
    // 500 so Stripe retries: reaching here means Firestore or our own code
    // failed, not that the event was unprocessable.
    console.error(
      `${LOG_PREFIX} ${event.type} ${event.id}: handler failed — ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return NextResponse.json({ error: 'Webhook handling failed' }, { status: 500 });
  }
}
