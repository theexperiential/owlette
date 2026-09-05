/**
 * roost webhook emission — producer side of the production dispatcher.
 *
 * roost events do NOT use `webhookSender.server.ts` (legacy alerting: own
 * signature header, immediate fetch, no retry budget). They are queued as
 * `webhook_deliveries` and shipped by the pump in
 * `functions/src/webhookDispatch.ts`, which owns backoff, give-up,
 * auto-disable and the billing lockout gate.
 *
 * The record shape here must stay byte-identical to `buildDelivery()` in the
 * dispatcher (same envelope, `Roost-Delivery` id, `Roost-Signature`); the retry
 * route writes the same shape.
 *
 * Not billing-gated, mirroring the dispatcher's `emit()`: nothing here reaches a
 * customer endpoint, and the pump re-checks the lockout at send time.
 *
 * Subscriptions are read in both shapes: `signingSecret`+`paused` (public API)
 * and the older `secret`+`enabled`.
 */

import { createHash } from 'node:crypto';
import { WEBHOOK_SECRETS_COLLECTION } from '@/lib/webhookSecrets.server';

import type { Firestore } from 'firebase-admin/firestore';

import type { RoostWebhookEvent } from '@/lib/webhookEvents';
import { signPayload } from '@/lib/webhookSignature';

const DELIVERIES_COLLECTION = 'webhook_deliveries';

/**
 * Canonical envelope, matching the dispatcher's `WebhookPayload`. No top-level
 * `id`: delivery identity lives in the `Roost-Delivery` header, stable across
 * retries so receivers can dedup on it.
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

/** `sha256(event|siteId|body)` truncated to 32 hex — mirrors `deliveryId()` in
 *  `functions/src/lib/webhookLogic.ts`. */
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
  // Legacy in-document secrets only — the current location is the server-only
  // sibling, read separately below. A subscription with neither is skipped.
  const legacySecret =
    typeof data.signingSecret === 'string' && data.signingSecret
      ? data.signingSecret
      : typeof data.secret === 'string' && data.secret
        ? data.secret
        : '';
  return { id, url, secret: legacySecret };
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
 * Never throws — a webhook that can't be queued must not fail the mutation that
 * produced it (same contract as `fireWebhooks`/`emitMutation`); failures are
 * logged loudly instead. Returns the number of deliveries queued.
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

    const candidates = snap.docs
      .map((doc) => resolveSubscription(doc.id, doc.data()))
      .filter((sub): sub is ResolvedSubscription => sub !== null);
    if (candidates.length === 0) return 0;

    // Secrets live outside the webhook document (lib/webhookSecrets.server.ts).
    // One batched read for the whole fan-out; the legacy in-document value is the
    // fallback for subscriptions that predate the migration, and a subscription
    // with no secret at all cannot be signed for, so it is dropped.
    const secretSnaps = await db.getAll(
      ...candidates.map((sub) =>
        db
          .collection('sites')
          .doc(siteId)
          .collection(WEBHOOK_SECRETS_COLLECTION)
          .doc(sub.id),
      ),
    );
    const subscribers = candidates
      .map((sub, i) => {
        const stored = secretSnaps[i]?.data();
        const secret =
          typeof stored?.signingSecret === 'string' && stored.signingSecret
            ? stored.signingSecret
            : sub.secret;
        return secret ? { ...sub, secret } : null;
      })
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
        // Per-subscriber record id so two subscriptions to one event don't
        // collide; the header's public id stays the pure content hash.
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
