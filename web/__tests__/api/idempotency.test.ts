/** @jest-environment node */

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
      expect(result.token.bodyHash).toMatch(/^[0-9a-f]{64}$/);
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
        body: '{"manifestId":"m1"}',
        expiresAt: Date.now() + 60_000,
      }),
    });
    const result = await checkIdempotency(reqWithKey('idem-abc'), CTX, raw);
    expect(result.mode).toBe('replay');
    if (result.mode === 'replay') {
      expect(result.response.status).toBe(201);
      expect(result.response.headers.get('Idempotent-Replayed')).toBe('true');
      const body = await result.response.json();
      expect(body.manifestId).toBe('m1');
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
