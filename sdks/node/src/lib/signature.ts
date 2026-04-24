/**
 * Webhook signature verification — matches the server dispatcher at
 * `functions/src/webhookDispatch.ts` (which ships the stripe-style
 * `Roost-Signature: t=<unix>,v1=<hmac-sha256-hex>` format).
 *
 * Public API used by consumers:
 *
 *   import { verifySignature } from '@owlette/roost';
 *   const ok = verifySignature(request.headers['roost-signature'], rawBody, secret);
 *
 * The verify fn is designed to be called on the raw request body
 * **before** any JSON parsing — reserialization changes byte order and
 * breaks the hash. If your framework hands you a parsed body only, use
 * a raw-body middleware (express `express.raw()`, fastify `@fastify/raw-body`)
 * to get the original bytes.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Default replay tolerance window matches the docs (5 minutes). */
export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 5 * 60;

export interface VerifySignatureOptions {
  /**
   * Reject signatures whose `t=` is more than this many seconds in the
   * past (or future). Default: 300s. Set to `Infinity` to skip the
   * freshness check.
   */
  toleranceSeconds?: number;
  /** Current time injection for deterministic tests. Default: Date.now(). */
  now?: () => number;
}

export interface VerifySignatureResult {
  ok: boolean;
  reason?:
    | 'missing_header'
    | 'malformed_header'
    | 'missing_timestamp'
    | 'missing_v1'
    | 'timestamp_out_of_tolerance'
    | 'bad_signature';
  /** Timestamp from `t=` when extractable, `null` otherwise. */
  timestamp: number | null;
}

/**
 * Parse + verify `Roost-Signature` over a raw body buffer.
 */
export function verifySignature(
  header: string | null | undefined,
  body: string | Buffer,
  secret: string,
  opts: VerifySignatureOptions = {},
): VerifySignatureResult {
  if (!header || header.length === 0) {
    return { ok: false, reason: 'missing_header', timestamp: null };
  }

  // Parse t= / v1= pairs from the header.
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  let t: number | null = null;
  const v1s: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) t = n;
    } else if (k === 'v1') {
      v1s.push(v);
    }
  }

  if (t === null) return { ok: false, reason: 'missing_timestamp', timestamp: null };
  if (v1s.length === 0) {
    return { ok: false, reason: 'missing_v1', timestamp: t };
  }

  const tolerance = opts.toleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS;
  if (Number.isFinite(tolerance)) {
    const now = opts.now ? opts.now() : Date.now();
    const ageSeconds = Math.abs(now / 1000 - t);
    if (ageSeconds > tolerance) {
      return { ok: false, reason: 'timestamp_out_of_tolerance', timestamp: t };
    }
  }

  // Signed payload is `${t}.${rawBody}` — match server.
  const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
  const expected = createHmac('sha256', secret)
    .update(`${t}.${bodyStr}`)
    .digest();

  for (const sig of v1s) {
    const candidate = Buffer.from(sig, 'hex');
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) {
      return { ok: true, timestamp: t };
    }
  }

  return { ok: false, reason: 'bad_signature', timestamp: t };
}

/**
 * Convenience boolean form — throws away the reason. Use the full
 * `verifySignature` when you want to surface 'missing_header' vs
 * 'bad_signature' to the caller (e.g. different 401 messages).
 */
export function isSignatureValid(
  header: string | null | undefined,
  body: string | Buffer,
  secret: string,
  opts: VerifySignatureOptions = {},
): boolean {
  return verifySignature(header, body, secret, opts).ok;
}

/**
 * Produce a header value with the server's canonical shape. Useful for
 * client-side tests that need to fake a signed delivery.
 */
export function signBody(
  body: string | Buffer,
  secret: string,
  timestampSeconds?: number,
): string {
  const t = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
  const v1 = createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
