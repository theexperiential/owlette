/** @jest-environment node */

import { createHmac } from 'node:crypto';

import {
  DEFAULT_REPLAY_TOLERANCE_SECONDS,
  signPayload,
  verifySignature,
} from '@/lib/webhookSignature';

const BODY = JSON.stringify({ event: 'manifest.published', data: { roostId: 'rst_abc' } });
const SECRET = 'whsec_test_abcdefabcdefabcdefabcdefabcdefab';
const NOW_MS = Date.parse('2026-04-22T15:30:00Z');

describe('signPayload', () => {
  it('emits a t=<unix>,v1=<hex> header', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('uses Math.floor(nowMs / 1000) for t', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const expectedT = Math.floor(NOW_MS / 1000);
    expect(sig.startsWith(`t=${expectedT},v1=`)).toBe(true);
  });

  it('v1 is hmac_sha256(secret, "<t>.<body>")', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const t = Math.floor(NOW_MS / 1000);
    const expected = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex');
    expect(sig).toBe(`t=${t},v1=${expected}`);
  });

  it('changing the body changes the signature', () => {
    const a = signPayload(BODY, SECRET, NOW_MS);
    const b = signPayload(BODY + ' ', SECRET, NOW_MS);
    expect(a).not.toBe(b);
  });

  it('changing the secret changes the signature', () => {
    const a = signPayload(BODY, SECRET, NOW_MS);
    const b = signPayload(BODY, SECRET + 'x', NOW_MS);
    expect(a).not.toBe(b);
  });

  it('same inputs → same output (deterministic)', () => {
    expect(signPayload(BODY, SECRET, NOW_MS)).toBe(signPayload(BODY, SECRET, NOW_MS));
  });
});

describe('verifySignature — happy path', () => {
  it('round-trips: a signature verifies against its own body + secret', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const result = verifySignature(BODY, SECRET, sig, { nowMs: NOW_MS });
    expect(result.ok).toBe(true);
    expect(result.timestamp).toBe(Math.floor(NOW_MS / 1000));
    expect(result.reason).toBeUndefined();
  });
});

describe('verifySignature — failure matrix', () => {
  it('missing header → missing_header', () => {
    expect(verifySignature(BODY, SECRET, null).reason).toBe('missing_header');
    expect(verifySignature(BODY, SECRET, undefined).reason).toBe('missing_header');
    expect(verifySignature(BODY, SECRET, '').reason).toBe('missing_header');
  });

  it('missing timestamp component → missing_timestamp', () => {
    const header = `v1=${'a'.repeat(64)}`;
    expect(verifySignature(BODY, SECRET, header).reason).toBe('missing_timestamp');
  });

  it('missing v1 component → missing_v1', () => {
    const header = `t=${Math.floor(NOW_MS / 1000)}`;
    expect(verifySignature(BODY, SECRET, header, { nowMs: NOW_MS }).reason).toBe('missing_v1');
  });

  it('malformed header (no = separator) → malformed_header', () => {
    expect(verifySignature(BODY, SECRET, 'no-equals-here').reason).toBe('malformed_header');
  });

  it('malformed t= (non-numeric) → malformed_header', () => {
    expect(verifySignature(BODY, SECRET, 't=not-a-number,v1=abc').reason).toBe('malformed_header');
  });

  it('malformed v1 (non-hex) → malformed_header', () => {
    const t = Math.floor(NOW_MS / 1000);
    expect(
      verifySignature(BODY, SECRET, `t=${t},v1=not_hex!!`, { nowMs: NOW_MS }).reason,
    ).toBe('malformed_header');
  });

  it('wrong secret → bad_signature', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const result = verifySignature(BODY, 'other_secret', sig, { nowMs: NOW_MS });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
    expect(result.timestamp).toBe(Math.floor(NOW_MS / 1000));
  });

  it('tampered body → bad_signature', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const tampered = BODY.replace('rst_abc', 'rst_attacker');
    const result = verifySignature(tampered, SECRET, sig, { nowMs: NOW_MS });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('replayed sig > 5min → timestamp_out_of_tolerance', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const sixMinLater = NOW_MS + 6 * 60 * 1000;
    const result = verifySignature(BODY, SECRET, sig, { nowMs: sixMinLater });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_tolerance');
  });

  it('replayed sig exactly at the edge (within tolerance) → ok', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const atEdge = NOW_MS + DEFAULT_REPLAY_TOLERANCE_SECONDS * 1000;
    const result = verifySignature(BODY, SECRET, sig, { nowMs: atEdge });
    expect(result.ok).toBe(true);
  });

  it('replayed sig in the future > 5min also rejected (clock-skew guard)', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS + 6 * 60 * 1000);
    const result = verifySignature(BODY, SECRET, sig, { nowMs: NOW_MS });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_tolerance');
  });

  it('custom toleranceSeconds honored', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const oneHourLater = NOW_MS + 60 * 60 * 1000;
    // default 5 min → would reject
    expect(verifySignature(BODY, SECRET, sig, { nowMs: oneHourLater }).reason).toBe(
      'timestamp_out_of_tolerance',
    );
    // 2h tolerance → accept
    expect(
      verifySignature(BODY, SECRET, sig, {
        nowMs: oneHourLater,
        toleranceSeconds: 2 * 60 * 60,
      }).ok,
    ).toBe(true);
  });
});

describe('verifySignature — forward-compat + edge cases', () => {
  it('unknown scheme prefixes (e.g. v2=) are ignored; v1 still verifies', () => {
    const base = signPayload(BODY, SECRET, NOW_MS);
    const withFutureV2 = `${base},v2=${'x'.repeat(64)}`;
    const result = verifySignature(BODY, SECRET, withFutureV2, { nowMs: NOW_MS });
    expect(result.ok).toBe(true);
  });

  it('multiple v1= values: accepts if any matches (rotation grace)', () => {
    const real = signPayload(BODY, SECRET, NOW_MS);
    // real ends with v1=<hex>; tack on a fake v1 alongside and confirm we still
    // accept because one matches. Stripe does this during secret rotation.
    const t = real.split(',')[0]; // t=<unix>
    const goodHash = real.split('v1=')[1];
    const header = `${t},v1=${'0'.repeat(64)},v1=${goodHash}`;
    expect(verifySignature(BODY, SECRET, header, { nowMs: NOW_MS }).ok).toBe(true);
  });

  it('whitespace between parts is tolerated', () => {
    const sig = signPayload(BODY, SECRET, NOW_MS);
    const [tPart, v1Part] = sig.split(',');
    const spaced = `${tPart} ,  ${v1Part}  `;
    expect(verifySignature(BODY, SECRET, spaced, { nowMs: NOW_MS }).ok).toBe(true);
  });

  it('v1 with wrong length never matches (even if prefix does) — bad_signature', () => {
    const base = signPayload(BODY, SECRET, NOW_MS);
    const [tPart, v1Part] = base.split(',');
    const truncated = v1Part!.slice(0, v1Part!.length - 2);
    const header = `${tPart},${truncated}`;
    const result = verifySignature(BODY, SECRET, header, { nowMs: NOW_MS });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('timestamp <= 0 → malformed_header', () => {
    expect(verifySignature(BODY, SECRET, 't=0,v1=abc').reason).toBe('malformed_header');
    expect(verifySignature(BODY, SECRET, 't=-5,v1=abc').reason).toBe('malformed_header');
  });

  it('empty body still signs + verifies', () => {
    const sig = signPayload('', SECRET, NOW_MS);
    expect(verifySignature('', SECRET, sig, { nowMs: NOW_MS }).ok).toBe(true);
  });
});
