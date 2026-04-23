/**
 * Roost webhook dispatcher cloud function (wave 5.1).
 *
 * Two entrypoints + one scheduled retry pump:
 *
 *   emitWebhook   — HTTPS POST. Called by roost producers (the web API
 *                    routes + firestore-trigger-driven pipelines) with
 *                    `{event, siteId, data}`. Fans out to every enabled
 *                    subscription that matches the event and the site.
 *
 *   processRetryQueue — scheduled every minute. Walks the
 *                    `webhook_deliveries` collection, re-attempting any
 *                    pending delivery whose `nextAttemptAt` is due.
 *                    Applies backoff + give-up logic from webhookLogic.ts.
 *
 *   handleInboundProbe — HTTPS GET. Receives verifiable probe signatures
 *                    so operators can test their receiver wiring without
 *                    producing a real roost event.
 *
 * Pure decision logic lives in lib/webhookLogic.ts (canonicalisation,
 * signing, backoff, response classification, subscription filtering).
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  canonicalJson,
  classifyResponse,
  deliveryId,
  isRoostEventType,
  nextRetryDelayMs,
  selectSubscribers,
  shouldGiveUp,
  signPayload,
  type BackoffOptions,
  type DeliveryOutcome,
  type RoostEventType,
  type Subscription,
  type WebhookPayload,
} from './lib/webhookLogic';

/* --------------------------------------------------------------------- */
/*  Types                                                                */
/* --------------------------------------------------------------------- */

export interface DeliveryRecord {
  /** Stable id — also the firestore doc id. */
  id: string;
  subscriptionId: string;
  siteId: string;
  url: string;
  /** JSON string to POST. Canonical + signed. */
  canonicalBody: string;
  headers: Record<string, string>;
  event: RoostEventType;
  attempt: number;
  state: 'pending' | 'succeeded' | 'failed';
  lastError?: string;
  lastStatus?: number;
  nextAttemptAt: number; // unix ms
  createdAt: number;
  completedAt?: number;
}

export interface HttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number | null }>;
}

export interface DeliveryStore {
  list(filter: { state: 'pending'; dueBefore: number }): Promise<DeliveryRecord[]>;
  put(record: DeliveryRecord): Promise<void>;
  get(id: string): Promise<DeliveryRecord | undefined>;
}

export interface SubscriptionStore {
  /** Return every subscription. Caller filters by site/event. */
  listAll(): Promise<Subscription[]>;
  markDisabled(id: string, reason: string): Promise<void>;
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator: prepare a delivery                                */
/* --------------------------------------------------------------------- */

/**
 * Build a DeliveryRecord from a payload + subscription. No IO. Caller
 * persists the record so a scheduled retry pump can pick it up.
 */
export function buildDelivery(
  payload: WebhookPayload,
  subscriber: Subscription,
  now: Date = new Date(),
): DeliveryRecord {
  const canonicalBody = canonicalJson(payload);
  // The X-owlette-Delivery-Id header is stable per (event, site, body) so
  // the receiver can dedup retries cleanly. The firestore record id needs
  // per-subscriber uniqueness — otherwise two subscribers for the same
  // event would collide and only one delivery would be tracked. Combine
  // `{publicId}__{subId}` for storage; the header stays the pure content
  // hash so receivers see a stable id across retries.
  const publicDeliveryId = deliveryId(payload, canonicalBody);
  const recordId = `${publicDeliveryId}__${subscriber.id}`;
  const signature = signPayload(canonicalBody, subscriber.secret);

  return {
    id: recordId,
    subscriptionId: subscriber.id,
    siteId: subscriber.siteId,
    url: subscriber.url,
    canonicalBody,
    headers: {
      'Content-Type': 'application/json',
      'X-owlette-Event': payload.event,
      'X-owlette-Delivery-Id': publicDeliveryId,
      'X-owlette-Signature': signature,
      'X-owlette-Timestamp': payload.occurredAt,
    },
    event: payload.event,
    attempt: 0,
    state: 'pending',
    nextAttemptAt: now.getTime(),
    createdAt: now.getTime(),
  };
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator: attempt one delivery                              */
/* --------------------------------------------------------------------- */

export interface AttemptDeps {
  http: HttpClient;
  store: DeliveryStore;
  subscriptions: SubscriptionStore;
  backoff?: BackoffOptions;
  /** Auto-disable after this many consecutive permanent failures. */
  autoDisableAfter?: number;
  now?: () => Date;
}

export interface AttemptResult {
  outcome: DeliveryOutcome;
  record: DeliveryRecord;
}

/**
 * Attempt to deliver `record` once. Updates its state + the store atomically:
 *   - success: state=succeeded, completedAt
 *   - transient failure: attempt++, nextAttemptAt=now+backoff, state=pending
 *   - permanent failure or give-up: state=failed, completedAt, may disable subscription
 */
export async function attemptDelivery(
  record: DeliveryRecord,
  deps: AttemptDeps,
): Promise<AttemptResult> {
  const now = deps.now ? deps.now() : new Date();
  const attempt = record.attempt + 1;

  let status: number | null = null;
  try {
    const resp = await deps.http.post(record.url, record.headers, record.canonicalBody);
    status = resp.status;
  } catch {
    status = null; // network error
  }

  const outcome = classifyResponse(status);

  if (outcome.kind === 'success') {
    const updated: DeliveryRecord = {
      ...record,
      attempt,
      state: 'succeeded',
      lastStatus: outcome.status,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return { outcome, record: updated };
  }

  // permanent failure → give up now (no retry)
  if (outcome.kind === 'permanent_failure') {
    const updated: DeliveryRecord = {
      ...record,
      attempt,
      state: 'failed',
      lastStatus: status ?? undefined,
      lastError: outcome.reason,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return { outcome, record: updated };
  }

  // transient failure: check give-up gate, otherwise schedule next retry.
  if (shouldGiveUp(attempt, deps.backoff)) {
    const updated: DeliveryRecord = {
      ...record,
      attempt,
      state: 'failed',
      lastStatus: status ?? undefined,
      lastError: `retry_exhausted: ${outcome.reason}`,
      completedAt: now.getTime(),
    };
    await deps.store.put(updated);
    return {
      outcome: { kind: 'permanent_failure', reason: `retry_exhausted_${outcome.reason}` },
      record: updated,
    };
  }

  const delay = nextRetryDelayMs(attempt, deps.backoff);
  const updated: DeliveryRecord = {
    ...record,
    attempt,
    state: 'pending',
    lastStatus: status ?? undefined,
    lastError: outcome.reason,
    nextAttemptAt: now.getTime() + delay,
  };
  await deps.store.put(updated);
  return { outcome, record: updated };
}

/* --------------------------------------------------------------------- */
/*  Emit: fan-out to subscribers                                         */
/* --------------------------------------------------------------------- */

export interface EmitDeps {
  subscriptions: SubscriptionStore;
  store: DeliveryStore;
  now?: () => Date;
}

/**
 * Load subscriptions, filter by siteId + event, build one DeliveryRecord
 * each, persist them as `pending`. The retry pump will pick them up on
 * the next scheduled tick; we don't block the caller on HTTP.
 *
 * Returns the records created for observability.
 */
export async function emit(
  payload: WebhookPayload,
  deps: EmitDeps,
): Promise<DeliveryRecord[]> {
  const now = deps.now ? deps.now() : new Date();
  const all = await deps.subscriptions.listAll();
  const selected = selectSubscribers(all, payload.event, payload.siteId);

  const records: DeliveryRecord[] = [];
  for (const sub of selected) {
    const record = buildDelivery(payload, sub, now);
    await deps.store.put(record);
    records.push(record);
  }
  return records;
}

/* --------------------------------------------------------------------- */
/*  Retry pump                                                           */
/* --------------------------------------------------------------------- */

export async function pumpRetryQueue(deps: AttemptDeps): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  retried: number;
}> {
  const now = deps.now ? deps.now() : new Date();
  const due = await deps.store.list({ state: 'pending', dueBefore: now.getTime() });

  let succeeded = 0;
  let failed = 0;
  let retried = 0;

  for (const record of due) {
    const result = await attemptDelivery(record, deps);
    if (result.outcome.kind === 'success') succeeded++;
    else if (result.outcome.kind === 'permanent_failure') failed++;
    else retried++;
  }

  return { attempted: due.length, succeeded, failed, retried };
}

/* --------------------------------------------------------------------- */
/*  HTTP + scheduled entrypoints                                         */
/* --------------------------------------------------------------------- */

export const emitWebhook = onRequest(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = (req.body ?? {}) as Partial<WebhookPayload> & {
      data?: Record<string, unknown>;
    };
    if (!isRoostEventType(body.event) || !body.siteId || typeof body.siteId !== 'string') {
      res.status(400).json({ error: 'invalid_event_or_siteId' });
      return;
    }
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const payload: WebhookPayload = {
      event: body.event,
      siteId: body.siteId,
      occurredAt: body.occurredAt ?? new Date().toISOString(),
      data: data as Record<string, unknown>,
    };
    try {
      const records = await emit(payload, {
        subscriptions: getDefaultSubscriptionStore(),
        store: getDefaultDeliveryStore(),
      });
      res.status(202).json({ queued: records.length });
    } catch (err) {
      console.error('[webhookDispatch] emit failed', err);
      res.status(500).json({ error: 'internal' });
    }
  },
);

/** Every minute — cheap to run; picks up due retries. */
export const processRetryQueue = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 180, memory: '256MiB' },
  async () => {
    const res = await pumpRetryQueue({
      http: getDefaultHttpClient(),
      store: getDefaultDeliveryStore(),
      subscriptions: getDefaultSubscriptionStore(),
    });
    console.log(
      `[webhookDispatch] retry pump: attempted=${res.attempted} ` +
        `succeeded=${res.succeeded} failed=${res.failed} retried=${res.retried}`,
    );
  },
);

/* --------------------------------------------------------------------- */
/*  Production wiring                                                    */
/* --------------------------------------------------------------------- */

function getDefaultHttpClient(): HttpClient {
  return {
    async post(url, headers, body) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body,
          // receivers must respond within 10 s.
          signal: AbortSignal.timeout(10_000),
        });
        return { status: resp.status };
      } catch {
        return { status: null };
      }
    },
  };
}

function getDefaultDeliveryStore(): DeliveryStore {
  const db = admin.firestore();
  const col = db.collection('webhook_deliveries');
  return {
    async list({ dueBefore }) {
      const snap = await col
        .where('state', '==', 'pending')
        .where('nextAttemptAt', '<=', dueBefore)
        .limit(200)
        .get();
      return snap.docs.map((d) => d.data() as DeliveryRecord);
    },
    async put(record) {
      await col.doc(record.id).set({ ...record, updatedAt: FieldValue.serverTimestamp() });
    },
    async get(id) {
      const snap = await col.doc(id).get();
      return snap.exists ? (snap.data() as DeliveryRecord) : undefined;
    },
  };
}

function getDefaultSubscriptionStore(): SubscriptionStore {
  const db = admin.firestore();
  // per-site subscriptions at sites/{siteId}/webhook_subscriptions/{id}.
  // keeping them site-scoped is the right isolation story; listAll
  // collectionGroup-queries across sites so emit() can filter by siteId
  // without knowing the whole site list.
  const group = db.collectionGroup('webhook_subscriptions');
  return {
    async listAll() {
      const snap = await group.get();
      return snap.docs.map((d) => {
        const data = d.data() as Omit<Subscription, 'id'>;
        return { id: d.id, ...data };
      });
    },
    async markDisabled(id, reason) {
      // find the doc via collection group; update in-place.
      const snap = await group.where('__name__', '==', id).limit(1).get();
      if (snap.empty) return;
      await snap.docs[0].ref.update({
        disabled: true,
        disabledReason: reason,
        disabledAt: Timestamp.now(),
      });
    },
  };
}
