/**
 * Stripe-style webhook signing + verification (wave 6.9).
 *
 * Web-side copy of the dispatcher's `functions/src/lib/webhookLogic.ts`
 * — we intentionally duplicate the pure-logic code here rather than
 * cross-import between the `functions/` and `web/` packages. The two
 * implementations MUST stay byte-compatible: any test suite that
 * signs in one and verifies in the other is catching drift early.
 *
 * Header format:
 *
 *     Roost-Signature: t=<unix-seconds>,v1=<hex>
 *     v1 = hmac_sha256(secret, "<t>.<canonicalBody>")
 *
 * The timestamp is part of the signed payload — receivers reject any
 * delivery whose `t` is more than 5 minutes from their wall clock.
 */

import { createHmac } from 'node:crypto';

export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;

/**
 * Sign `canonicalBody` with `secret`. Returns the full `Roost-Signature`
 * header value. `nowMs` is injectable for deterministic tests.
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
 * Verify a `Roost-Signature` header against `canonicalBody` + `secret`.
 * Returns structured outcome so callers can distinguish stale-timestamp
 * from bad-hmac in their logs/metrics.
 *
 * Forward-compatible: unknown scheme prefixes (e.g. future `v2=`) are
 * ignored, not errors — exactly what Stripe recommends.
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
    // unknown scheme prefixes ignored per stripe convention.
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
    for (let i = 0; i < expectedBuf.length; i++) diff |= expectedBuf[i]! ^ candBuf[i]!;
    if (diff === 0) return { ok: true, timestamp: t };
  }
  return { ok: false, reason: 'bad_signature', timestamp: t };
}
