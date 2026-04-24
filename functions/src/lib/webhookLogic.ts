/**
 * Pure logic for the roost webhook subsystem.
 *
 * Roost emits structured events for the release-engineering lifecycle.
 * External pipelines (CI runners, operator alerting) subscribe per-site
 * and receive HMAC-SHA256-signed POSTs on every matching event. This
 * module handles the signing, canonicalisation, backoff, and retry-budget
 * decisions; the handler in webhookDispatch.ts does the HTTP.
 *
 * Wire format (stripe-style, wave 6.9):
 *   POST {subscriber.url}
 *   Content-Type: application/json
 *   Roost-Event:     <event.type>
 *   Roost-Delivery:  <uuid>                    (stable across retries for dedup)
 *   Roost-Signature: t=<unix>,v1=<hex>         (unix seconds + hmac-sha256 over "t.body")
 *   {canonical JSON body}
 *
 * The signature is `v1 = hmac_sha256(secret, "<t>.<raw_body>")` where
 * `<t>` is the unix-seconds timestamp encoded in the same header. The
 * timestamp is *part* of the signed payload, which prevents replay:
 * receivers reject any delivery whose `t` is more than 5 minutes away
 * from their own clock (`DEFAULT_REPLAY_TOLERANCE_SECONDS`).
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
/*  Signing (stripe-style: t=<unix>,v1=<hex> over "t.body")              */
/* --------------------------------------------------------------------- */

/** 5-minute default replay-window for verifiers. */
export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;

/**
 * Compute the `Roost-Signature` header value for a payload given a shared
 * secret. The signature is
 *
 *     v1 = hmac_sha256(secret, "<t>.<canonicalBody>")
 *
 * encoded as `t=<unix>,v1=<hex>` so the timestamp is part of the signed
 * material. Receivers MUST re-compute v1 and reject any `t` older than
 * `DEFAULT_REPLAY_TOLERANCE_SECONDS` (5 min) to block replay attacks.
 *
 * `nowMs` is injectable for deterministic tests; production callers pass
 * nothing and get `Date.now()`.
 */
export function signPayload(
  canonicalBody: string,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const t = Math.floor(nowMs / 1000);
  const hex = createHmac('sha256', secret).update(`${t}.${canonicalBody}`).digest('hex');
  return `t=${t},v1=${hex}`;
}

/** Reasons verification can fail — exposed so callers can log a stable code. */
export type VerifyFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'missing_timestamp'
  | 'missing_v1'
  | 'timestamp_out_of_tolerance'
  | 'bad_signature';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailureReason;
  timestamp: number | null;
}

/**
 * Constant-time signature verification helper for use by receivers. Kept
 * here so first-party integrations can import a shared implementation
 * instead of rolling their own (common source of timing leaks).
 *
 * Returns a structured result so callers can distinguish stale-timestamp
 * from bad-hmac in their logs / metrics.
 */
export function verifySignature(
  canonicalBody: string,
  secret: string,
  receivedHeader: string | null | undefined,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): VerifyResult {
  if (!receivedHeader || receivedHeader.length === 0) {
    return { ok: false, reason: 'missing_header', timestamp: null };
  }

  const parts = receivedHeader.split(',').map((p) => p.trim()).filter(Boolean);
  let t: number | null = null;
  const v1s: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed_header', timestamp: t };
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, reason: 'malformed_header', timestamp: null };
      }
      t = n;
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) {
        return { ok: false, reason: 'malformed_header', timestamp: t };
      }
      v1s.push(value.toLowerCase());
    }
    // unknown scheme prefixes (e.g. future `v2=`) ignored per stripe convention.
  }

  if (t === null) return { ok: false, reason: 'missing_timestamp', timestamp: null };
  if (v1s.length === 0) return { ok: false, reason: 'missing_v1', timestamp: t };

  const tolerance = opts.toleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS;
  if (Number.isFinite(tolerance)) {
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSec - t) > tolerance) {
      return { ok: false, reason: 'timestamp_out_of_tolerance', timestamp: t };
    }
  }

  const expected = createHmac('sha256', secret).update(`${t}.${canonicalBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  for (const candidate of v1s) {
    if (candidate.length !== expected.length) continue;
    const candBuf = Buffer.from(candidate, 'utf-8');
    let diff = 0;
    for (let i = 0; i < expectedBuf.length; i++) diff |= expectedBuf[i] ^ candBuf[i];
    if (diff === 0) return { ok: true, timestamp: t };
  }
  return { ok: false, reason: 'bad_signature', timestamp: t };
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
