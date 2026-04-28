/** @jest-environment node */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }));

import {
  checkIdempotency,
  saveIdempotency,
  withIdempotency,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_MAX_KEY_LENGTH,
  type IdempotencyToken,
} from '@/lib/idempotency';

const CTX = { userId: 'user-1', environment: 'live' as const };

function reqWithKey(key: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (key !== null) headers[IDEMPOTENCY_HEADER] = key;
  return createMockRequest('http://localhost/api/test', {
    method: 'POST',
    headers,
    body: body as Record<string, unknown>,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.get.mockReset();
  mocks.set.mockResolvedValue(undefined);
});

describe('checkIdempotency', () => {
  it('returns disabled when header is missing', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const result = await checkIdempotency(reqWithKey(null), CTX, '{}');
    expect(result.mode).toBe('disabled');
  });

  it('returns missing when header is required but absent', async () => {
    const result = await checkIdempotency(reqWithKey(null), CTX, '{}', {
      requireKey: true,
    });
    expect(result.mode).toBe('missing');
    if (result.mode === 'missing') {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.code).toBe('idempotency_key_required');
      expect(body.param).toBe(IDEMPOTENCY_HEADER);
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns disabled when header is empty', async () => {
    const result = await checkIdempotency(reqWithKey(''), CTX, '{}');
    expect(result.mode).toBe('disabled');
  });

  it('returns invalid when key exceeds max length', async () => {
    const tooLong = 'a'.repeat(IDEMPOTENCY_MAX_KEY_LENGTH + 1);
    const result = await checkIdempotency(reqWithKey(tooLong), CTX, '{}');
    expect(result.mode).toBe('invalid');
    if (result.mode === 'invalid') {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.code).toBe('idempotency_key_invalid');
    }
  });

  it('returns proceed on cache miss, with a token carrying hashed body', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const result = await checkIdempotency(
      reqWithKey('idem-abc'),
      CTX,
      '{"a":1}',
    );
    expect(result.mode).toBe('proceed');
    if (result.mode === 'proceed') {
      expect(result.token.key).toBe('idem-abc');
      expect(result.token.userId).toBe('user-1');
      expect(result.token.environment).toBe('live');
      expect(result.token.method).toBe('POST');
      expect(result.token.path).toBe('/api/test');
      expect(result.token.query).toBe('');
      expect(result.token.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('scopes cache document ids by method, path, and query', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const sameRoute = await checkIdempotency(
      reqWithKey('same-key'),
      CTX,
      '{"a":1}',
    );
    const differentPath = await checkIdempotency(
      createMockRequest('http://localhost/api/other', {
        method: 'POST',
        headers: { [IDEMPOTENCY_HEADER]: 'same-key' },
        body: { a: 1 },
      }),
      CTX,
      '{"a":1}',
    );
    const differentQuery = await checkIdempotency(
      createMockRequest('http://localhost/api/test?mode=fast', {
        method: 'POST',
        headers: { [IDEMPOTENCY_HEADER]: 'same-key' },
        body: { a: 1 },
      }),
      CTX,
      '{"a":1}',
    );

    expect(sameRoute.mode).toBe('proceed');
    expect(differentPath.mode).toBe('proceed');
    expect(differentQuery.mode).toBe('proceed');
    if (
      sameRoute.mode === 'proceed' &&
      differentPath.mode === 'proceed' &&
      differentQuery.mode === 'proceed'
    ) {
      expect(differentPath.token.cacheDocId).not.toBe(sameRoute.token.cacheDocId);
      expect(differentQuery.token.cacheDocId).not.toBe(sameRoute.token.cacheDocId);
    }
  });

  it('returns replay on cache hit with matching body', async () => {
    const raw = '{"a":1}';
    const crypto = await import('crypto');
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'live',
        key: 'idem-abc',
        bodyHash,
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"versionId":"v1"}',
        expiresAt: Date.now() + 60_000,
      }),
    });
    const result = await checkIdempotency(reqWithKey('idem-abc'), CTX, raw);
    expect(result.mode).toBe('replay');
    if (result.mode === 'replay') {
      expect(result.response.status).toBe(201);
      expect(result.response.headers.get('Idempotent-Replayed')).toBe('true');
      const body = await result.response.json();
      expect(body.versionId).toBe('v1');
    }
  });

  it('returns mismatch on cache hit with different body', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'live',
        key: 'idem-abc',
        bodyHash: 'deadbeef'.repeat(8), // won't match
        status: 201,
        headers: {},
        body: '{}',
        expiresAt: Date.now() + 60_000,
      }),
    });
    const result = await checkIdempotency(
      reqWithKey('idem-abc'),
      CTX,
      '{"a":1}',
    );
    expect(result.mode).toBe('mismatch');
    if (result.mode === 'mismatch') {
      expect(result.response.status).toBe(422);
      const body = await result.response.json();
      expect(body.code).toBe('idempotency_key_mismatch');
    }
  });

  it('treats expired cache entries as miss and returns proceed', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({
        bodyHash: 'stale',
        status: 201,
        expiresAt: Date.now() - 1000, // expired
      }),
    });
    const result = await checkIdempotency(reqWithKey('idem-abc'), CTX, '{}');
    expect(result.mode).toBe('proceed');
  });
});

describe('saveIdempotency', () => {
  const token: IdempotencyToken = {
    cacheDocId: 'doc-id',
    key: 'idem-abc',
    bodyHash: 'abc'.repeat(21) + 'd',
    method: 'POST',
    path: '/api/test',
    query: '',
    userId: 'user-1',
    environment: 'live',
  };

  it('persists a 2xx response', async () => {
    const response = NextResponse.json({ ok: true }, { status: 201 });
    await saveIdempotency(token, response);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const saved = (mocks.set as jest.Mock).mock.calls[0][0];
    expect(saved.status).toBe(201);
    expect(saved.body).toBe('{"ok":true}');
    expect(saved.key).toBe('idem-abc');
  });

  it('does NOT persist a 4xx response', async () => {
    const response = NextResponse.json({ error: 'bad' }, { status: 400 });
    await saveIdempotency(token, response);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('does NOT persist a 5xx response', async () => {
    const response = NextResponse.json({ error: 'internal' }, { status: 500 });
    await saveIdempotency(token, response);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('swallows firestore errors silently', async () => {
    mocks.set.mockRejectedValueOnce(new Error('firestore down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const response = NextResponse.json({ ok: true }, { status: 201 });
    await expect(saveIdempotency(token, response)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('withIdempotency wrapper', () => {
  it('runs handler and persists 2xx when no cache hit', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const handler = jest.fn(async () =>
      NextResponse.json({ ok: true, n: 1 }, { status: 201 }),
    );

    const response = await withIdempotency(
      reqWithKey('idem-fresh'),
      CTX,
      '{"a":1}',
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(201);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const saved = (mocks.set as jest.Mock).mock.calls[0][0];
    expect(saved.status).toBe(201);
    expect(saved.body).toBe('{"ok":true,"n":1}');
  });

  it('returns cached replay without calling the handler on body-identical retry', async () => {
    const bodyHash = createHash('sha256')
      .update('{"a":1}')
      .digest('hex');
    const expiresAt = Date.now() + 1_000_000;
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({
        bodyHash,
        status: 201,
        body: '{"replayed":true}',
        headers: { 'content-type': 'application/json' },
        expiresAt,
      }),
    });
    const handler = jest.fn();

    const response = await withIdempotency(
      reqWithKey('idem-replay'),
      CTX,
      '{"a":1}',
      handler,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(response.headers.get('Idempotent-Replayed')).toBe('true');
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"replayed":true}');
  });

  it('returns 422 mismatch without calling the handler when body differs', async () => {
    const otherHash = createHash('sha256')
      .update('{"a":2}')
      .digest('hex');
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({
        bodyHash: otherHash,
        status: 201,
        body: '{}',
        headers: {},
        expiresAt: Date.now() + 1_000_000,
      }),
    });
    const handler = jest.fn();

    const response = await withIdempotency(
      reqWithKey('idem-mismatch'),
      CTX,
      '{"a":1}',
      handler,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe('idempotency_key_mismatch');
  });

  it('runs handler but skips save when no Idempotency-Key header is present', async () => {
    const handler = jest.fn(async () =>
      NextResponse.json({ ok: true }, { status: 200 }),
    );

    const response = await withIdempotency(
      reqWithKey(null),
      CTX,
      '{"a":1}',
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('rejects missing Idempotency-Key when requireKey is set', async () => {
    const handler = jest.fn(async () =>
      NextResponse.json({ ok: true }, { status: 200 }),
    );

    const response = await withIdempotency(
      reqWithKey(null),
      CTX,
      '{"a":1}',
      handler,
      { requireKey: true },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('idempotency_key_required');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('runs handler but does not persist a 4xx response', async () => {
    mocks.get.mockResolvedValue({ exists: false });
    const handler = jest.fn(async () =>
      NextResponse.json({ error: 'bad input' }, { status: 400 }),
    );

    const response = await withIdempotency(
      reqWithKey('idem-error'),
      CTX,
      '{"a":1}',
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('returns 400 invalid response when key exceeds max length, without calling the handler', async () => {
    const tooLong = 'a'.repeat(IDEMPOTENCY_MAX_KEY_LENGTH + 1);
    const handler = jest.fn();

    const response = await withIdempotency(
      reqWithKey(tooLong),
      CTX,
      '{}',
      handler,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
});
