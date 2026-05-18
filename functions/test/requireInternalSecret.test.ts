/**
 * Tests for the internal-only HTTPS Cloud Function auth helper.
 *
 * The helper is the only thing standing between the public emitWebhook /
 * quotaEnforce / telemetry HTTPS endpoints and the open internet, so its
 * fail-closed semantics matter:
 *
 *   - 503 when CORTEX_INTERNAL_SECRET is unset (operator misconfiguration)
 *   - 401 when the header is missing
 *   - 401 when the header length differs from the secret (timing-safe
 *     length check before the constant-time compare)
 *   - 401 when timing-safe compare fails
 *   - returns true (passes through) when the header matches the secret
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireInternalSecret } from '../src/lib/requireInternalSecret';

/* -------------------------------------------------------------------- */
/*  Fake express-style req/res shims                                    */
/* -------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------- */
/*  env helpers                                                          */
/* -------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------- */
/*  cases                                                               */
/* -------------------------------------------------------------------- */

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
    // Different length so timing-safe length check fails before bufferCompare.
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
    // No status / body should have been written.
    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
  });

  it('rejects empty string header even when secret is also empty string would mean misconfiguration (not_configured wins)', () => {
    // CORTEX_INTERNAL_SECRET being empty string is treated as unset by the
    // `if (!expected)` check — the env-var-missing path. This pins that
    // a deploy with an accidentally-cleared secret returns 503, not 200.
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
