/**
 * roost webhook emission — producer side of the production dispatcher.
 *
 * roost events (`version.*`, `deployment.*`, …) do NOT go through
 * `webhookSender.server.ts`: that is the legacy alerting path (its own
 * `X-owlette-Signature` header, immediate fetch, no retry budget). roost
 * events are queued as `webhook_deliveries` records and shipped by the
 * scheduled retry pump in `functions/src/webhookDispatch.ts`, which owns
 * backoff, give-up, auto-disable, and the billing lockout gate.
 *
 * The record shape below is the one `attemptDelivery()` consumes, and is
 * byte-identical to what `buildDelivery()` produces inside the dispatcher
 * — same canonical envelope, same content-addressed `Roost-Delivery` id,
 * same stripe-style `Roost-Signature`. `POST /api/webhooks/{id}/deliveries/
 * {deliveryId}/retry` writes the same record shape from the web side.
 *
 * Deliberately NOT billing-gated here, mirroring the dispatcher's `emit()`:
 * nothing in this file reaches a customer endpoint, and the pump — the only
 * thing that does — re-checks the lockout at send time.
 *
 * Subscription compatibility: public-api subscriptions store
 * `signingSecret` + `paused`; a handful of pre-public-api records used
 * `secret` + `enabled`. Both are read, matching the same tolerance
 * `WebhookSettingsDialog.tsx` already applies when listing them.
 */

import { createHash } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';

import type { RoostWebhookEvent } from '@/lib/webhookEvents';
import { signPayload } from '@/lib/webhookSignature';

const DELIVERIES_COLLECTION = 'webhook_deliveries';

/**
 * The canonical event envelope, matching the dispatcher's `WebhookPayload`.
 * No top-level `id` — delivery identity is carried by the `Roost-Delivery`
 * header, which is stable across retries so receivers can dedup on it.
 */
interface RoostWebhookEnvelope {
  event: RoostWebhookEvent;
  siteId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Recursive key-sort so sender and verifier agree on the exact bytes. */
function sortForCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortForCanonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Content-addressed public delivery id — `sha256(event|siteId|body)`
 * truncated to 32 hex chars. Mirrors `deliveryId()` in
 * `functions/src/lib/webhookLogic.ts`.
 */
function publicDeliveryId(envelope: RoostWebhookEnvelope, canonicalBody: string): string {
  return createHash('sha256')
    .update(`${envelope.event}|${envelope.siteId}|${canonicalBody}`)
    .digest('hex')
    .slice(0, 32);
}

interface ResolvedSubscription {
  id: string;
  url: string;
  secret: string;
}

function resolveSubscription(
  id: string,
  data: Record<string, unknown> | undefined,
): ResolvedSubscription | null {
  if (!data || data.deletedAt) return null;
  // `paused` is the public-api field; `enabled: false` is the legacy one.
  if (data.paused === true || data.enabled === false) return null;
  const url = typeof data.url === 'string' ? data.url : '';
  if (!url) return null;
  const secret =
    typeof data.signingSecret === 'string' && data.signingSecret
      ? data.signingSecret
      : typeof data.secret === 'string' && data.secret
        ? data.secret
        : '';
  if (!secret) return null;
  return { id, url, secret };
}

export interface EmitRoostWebhookArgs {
  db: Firestore;
  siteId: string;
  event: RoostWebhookEvent;
  /** Event-specific body, published verbatim under `data`. */
  data: Record<string, unknown>;
  /** Injectable clock for deterministic tests. */
  nowMs?: number;
}

/**
 * Queue `event` for every enabled subscription on `siteId` that asked for it.
 *
 * Never throws — a webhook that can't be queued must not fail the mutation
 * that produced it (same contract as `fireWebhooks` and `emitMutation`).
 * Failures are logged loudly instead, because a silently dropped event is
 * worse for the operator than a noisy log line.
 *
 * @returns the number of deliveries queued.
 */
export async function emitRoostWebhook(args: EmitRoostWebhookArgs): Promise<number> {
  const { db, siteId, event, data } = args;
  const nowMs = args.nowMs ?? Date.now();

  try {
    const snap = await db
      .collection('sites')
      .doc(siteId)
      .collection('webhooks')
      .where('events', 'array-contains', event)
      .get();

    const subscribers = snap.docs
      .map((doc) => resolveSubscription(doc.id, doc.data()))
      .filter((sub): sub is ResolvedSubscription => sub !== null);
    if (subscribers.length === 0) return 0;

    const envelope: RoostWebhookEnvelope = {
      event,
      siteId,
      occurredAt: new Date(nowMs).toISOString(),
      data,
    };
    const canonicalBody = JSON.stringify(sortForCanonical(envelope));
    const deliveryId = publicDeliveryId(envelope, canonicalBody);

    await Promise.all(
      subscribers.map((sub) => {
        // Record id is per-subscriber so two subscriptions to the same
        // event don't collide on one tracked delivery; the public id in
        // the header stays the pure content hash.
        const recordId = `${deliveryId}__${sub.id}`;
        return db
          .collection(DELIVERIES_COLLECTION)
          .doc(recordId)
          .set({
            id: recordId,
            subscriptionId: sub.id,
            siteId,
            url: sub.url,
            canonicalBody,
            headers: {
              'Content-Type': 'application/json',
              'Roost-Event': event,
              'Roost-Delivery': deliveryId,
              'Roost-Signature': signPayload(canonicalBody, sub.secret, nowMs),
            },
            event,
            attempt: 0,
            state: 'pending' as const,
            nextAttemptAt: nowMs,
            createdAt: nowMs,
            secret: sub.secret,
          });
      }),
    );

    return subscribers.length;
  } catch (err) {
    console.error(
      `[roostWebhooks] failed to queue ${event} for site ${siteId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
