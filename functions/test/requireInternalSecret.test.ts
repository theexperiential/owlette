/**
 * Internal-only HTTPS Cloud Function auth helper — the only thing between the public emitWebhook /
 * quotaEnforce / telemetry endpoints and the open internet, so fail-closed semantics matter:
 * 503 when CORTEX_INTERNAL_SECRET is unset, 401 on missing header / length mismatch / failed
 * constant-time compare, true only on an exact match.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireInternalSecret } from '../src/lib/requireInternalSecret';

/* Fake express-style req/res shims */
interface FakeRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return r;
}

function fakeReq(headers: Record<string, string>) {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Parameters<typeof requireInternalSecret>[0];
}

const ORIGINAL_SECRET = process.env.CORTEX_INTERNAL_SECRET;

beforeEach(() => {
  delete process.env.CORTEX_INTERNAL_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CORTEX_INTERNAL_SECRET;
  } else {
    process.env.CORTEX_INTERNAL_SECRET = ORIGINAL_SECRET;
  }
});

describe('requireInternalSecret', () => {
  it('503 when CORTEX_INTERNAL_SECRET env is not set (operator config error)', () => {
    const req = fakeReq({ 'x-internal-secret': 'whatever' });
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'not_configured' });
  });

  it('401 when x-internal-secret header is missing entirely', () => {
    process.env.CORTEX_INTERNAL_SECRET = 'real-secret';
    const req = fakeReq({});
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('401 when supplied header length differs from secret (short-circuit before compare)', () => {
    process.env.CORTEX_INTERNAL_SECRET = 'abcdefgh12345678';
    // Different length, so the length check fails before bufferCompare.
    const req = fakeReq({ 'x-internal-secret': 'short' });
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
  });

  it('401 when same length but timing-safe compare fails', () => {
    process.env.CORTEX_INTERNAL_SECRET = 'abcdefgh12345678';
    const req = fakeReq({ 'x-internal-secret': 'ZZZZZZZZ12345678' });
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
  });

  it('returns true (no res write) when supplied secret matches', () => {
    process.env.CORTEX_INTERNAL_SECRET = 'abcdefgh12345678';
    const req = fakeReq({ 'x-internal-secret': 'abcdefgh12345678' });
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, true);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
  });

  it('rejects empty string header even when secret is also empty string would mean misconfiguration (not_configured wins)', () => {
    // Empty string is unset per `if (!expected)`: an accidentally-cleared secret must 503, not 200.
    process.env.CORTEX_INTERNAL_SECRET = '';
    const req = fakeReq({ 'x-internal-secret': '' });
    const res = fakeRes();
    const ok = requireInternalSecret(
      req,
      res as unknown as Parameters<typeof requireInternalSecret>[1],
    );
    assert.equal(ok, false);
    assert.equal(res.statusCode, 503);
  });
});
