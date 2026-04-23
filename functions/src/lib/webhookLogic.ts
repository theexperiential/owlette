/**
 * Pure logic for the roost webhook subsystem (wave 5.1).
 *
 * Roost emits structured events for the release-engineering lifecycle.
 * External pipelines (CI runners, operator alerting) subscribe per-site
 * and receive HMAC-SHA256-signed POSTs on every matching event. This
 * module handles the signing, canonicalisation, backoff, and retry-budget
 * decisions; the handler in webhookDispatch.ts does the HTTP.
 *
 * Wire format:
 *   POST {subscriber.url}
 *   X-owlette-Event: <event.type>
 *   X-owlette-Delivery-Id: <uuid>
 *   X-owlette-Signature: sha256=<hex>
 *   X-owlette-Timestamp: <iso8601>
 *   Content-Type: application/json
 *   {canonical JSON body}
 *
 * The signature covers the raw bytes the receiver sees, so receivers
 * re-derive the HMAC from the body + their shared secret. Replay
 * protection: receivers should reject deliveries with timestamps older
 * than a small window (e.g. 5 minutes).
 */

import { createHash, createHmac } from 'crypto';

/* --------------------------------------------------------------------- */
/*  Event taxonomy                                                       */
/* --------------------------------------------------------------------- */

/**
 * Stable event names emitted by roost. Consumers pin on these strings —
 * renames are breaking changes. Extending the union requires a coordinated
 * release with the docs site (wave 5.6).
 */
export type RoostEventType =
  | 'distribution.queued'
  | 'distribution.started'
  | 'distribution.succeeded'
  | 'distribution.failed'
  | 'chunk.uploaded'
  | 'manifest.published'
  | 'rollback.executed';

export const ROOST_EVENT_TYPES: readonly RoostEventType[] = [
  'distribution.queued',
  'distribution.started',
  'distribution.succeeded',
  'distribution.failed',
  'chunk.uploaded',
  'manifest.published',
  'rollback.executed',
] as const;

export function isRoostEventType(x: unknown): x is RoostEventType {
  return typeof x === 'string' && (ROOST_EVENT_TYPES as readonly string[]).includes(x);
}

/* --------------------------------------------------------------------- */
/*  Payload                                                              */
/* --------------------------------------------------------------------- */

export interface WebhookPayload {
  /** Stable event name; receivers switch on this. */
  event: RoostEventType;
  /** The site the event belongs to. */
  siteId: string;
  /** ISO-8601 timestamp of the event (NOT the delivery attempt). */
  occurredAt: string;
  /** Opaque, event-specific payload. JSON-serialisable; object (not array). */
  data: Record<string, unknown>;
}

/**
 * Canonical JSON for signing: recursive key-sort so any two senders /
 * verifiers that speak this format agree on the byte sequence.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return out;
}

/* --------------------------------------------------------------------- */
/*  Signing                                                              */
/* --------------------------------------------------------------------- */

/**
 * Compute the signature for a payload given a shared secret.
 * Returned as `sha256=<hex>` so the `X-owlette-Signature` header is
 * unambiguous about the algorithm (mirrors GitHub's webhook convention).
 */
export function signPayload(
  canonicalBody: string,
  secret: string,
): string {
  const hex = createHmac('sha256', secret).update(canonicalBody).digest('hex');
  return `sha256=${hex}`;
}

/**
 * Constant-time signature verification helper for use by receivers.
 * Kept here so first-party integrations can import a shared implementation
 * instead of rolling their own (common source of timing leaks).
 */
export function verifySignature(
  canonicalBody: string,
  secret: string,
  receivedSignature: string,
): boolean {
  const expected = signPayload(canonicalBody, secret);
  if (expected.length !== receivedSignature.length) return false;
  // timing-safe comparison over hex digests.
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(receivedSignature, 'utf-8');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Stable delivery id for idempotency. Derived from `event + canonicalBody`
 * so retries of the same delivery send the same id. Receivers can dedup
 * on this header. Not cryptographic — just a stable content hash.
 */
export function deliveryId(payload: WebhookPayload, canonicalBody: string): string {
  return createHash('sha256')
    .update(`${payload.event}|${payload.siteId}|${canonicalBody}`)
    .digest('hex')
    .slice(0, 32);
}

/* --------------------------------------------------------------------- */
/*  Retry arithmetic                                                     */
/* --------------------------------------------------------------------- */

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  jitter?: number;
  maxAttempts?: number;
}

/** Compute the delay before retry-attempt `attempt` (1-indexed). */
export function nextRetryDelayMs(
  attempt: number,
  opts: BackoffOptions = {},
  rng: () => number = Math.random,
): number {
  const base = opts.baseMs ?? 5_000; // 5 s first retry (vs 1 s for uploads)
  const factor = opts.factor ?? 3;
  const max = opts.maxMs ?? 60 * 60 * 1000; // 1 h ceiling
  const jitter = opts.jitter ?? 0.2;

  if (attempt <= 0) return 0;
  const expo = base * Math.pow(factor, attempt - 1);
  const capped = Math.min(expo, max);
  const jitterFactor = 1 + (rng() * 2 - 1) * jitter;
  return Math.max(0, Math.round(capped * jitterFactor));
}

/** After this many attempts, mark the delivery failed. Default 10. */
export function shouldGiveUp(
  attempt: number,
  opts: BackoffOptions = {},
): boolean {
  const cap = opts.maxAttempts ?? 10;
  return attempt >= cap;
}

/**
 * Decide whether a particular HTTP response should trigger a retry.
 *
 * - 2xx: success, no retry.
 * - 4xx (except 408/425/429): permanent — bad URL / auth problem on the
 *   receiver's side. Retrying would spam. Mark failed.
 * - 408 / 425 / 429: transient — receiver is rate-limited or timed out.
 * - 5xx: transient.
 * - Network error (no status): transient.
 */
export type DeliveryOutcome =
  | { kind: 'success'; status: number }
  | { kind: 'retry'; reason: string }
  | { kind: 'permanent_failure'; reason: string };

export function classifyResponse(status: number | null): DeliveryOutcome {
  if (status === null) {
    return { kind: 'retry', reason: 'network_error' };
  }
  if (status >= 200 && status < 300) {
    return { kind: 'success', status };
  }
  if (status === 408 || status === 425 || status === 429) {
    return { kind: 'retry', reason: `transient_${status}` };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'permanent_failure', reason: `http_${status}` };
  }
  if (status >= 500) {
    return { kind: 'retry', reason: `http_${status}` };
  }
  // weird non-standard codes (e.g. 1xx / 3xx that somehow surface): treat
  // as permanent failure so we don't loop forever on oddities.
  return { kind: 'permanent_failure', reason: `http_${status}` };
}

/* --------------------------------------------------------------------- */
/*  Subscription filtering                                               */
/* --------------------------------------------------------------------- */

export interface Subscription {
  id: string;
  siteId: string;
  url: string;
  secret: string;
  /** Event types this subscription wants. Empty/missing = all roost events. */
  events?: RoostEventType[];
  /** If set by auto-disable, deliveries to this subscription are skipped. */
  disabled?: boolean;
}

/** Return the subset of subscriptions that should receive this event. */
export function selectSubscribers(
  subs: readonly Subscription[],
  event: RoostEventType,
  siteId: string,
): Subscription[] {
  return subs.filter((s) => {
    if (s.disabled) return false;
    if (s.siteId !== siteId) return false;
    if (!s.events || s.events.length === 0) return true;
    return s.events.includes(event);
  });
}
