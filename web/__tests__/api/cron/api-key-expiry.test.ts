/** @jest-environment node */

import { NextRequest } from 'next/server';

// Mocks (declared before importing the route)

const emailSend = jest.fn().mockResolvedValue({ error: null });
const getUserAlertRecipientMock = jest.fn();
const mockQueryGet = jest.fn();

/** Every `ref.set(...)` the run performs, as `[path, payload]`. */
const refSet = jest.fn().mockResolvedValue(undefined);
/** Interleaved record of stamps and sends, so ordering is assertable. */
let callOrder: string[] = [];

/** `where(...)` arguments recorded per `collectionGroup('api_keys')` build. */
let whereCalls: unknown[][] = [];

const query = {
  where: (...args: unknown[]) => {
    whereCalls.push(args);
    return query;
  },
  get: mockQueryGet,
};

const mockDb = {
  collectionGroup: jest.fn((name: string) => {
    if (name !== 'api_keys') throw new Error(`unexpected collection group: ${name}`);
    whereCalls = [];
    return query;
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getUserAlertRecipient: (...args: unknown[]) => getUserAlertRecipientMock(...args),
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => ({ emails: { send: emailSend } }),
  FROM_EMAIL: 'noreply@mail.owlette.app',
  ENV_LABEL: 'DEVELOPMENT',
  isProduction: false,
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: (uid: string) => `unsub-${uid}`,
}));

import {
  GET,
  classifyApiKeyExpiry,
  NOTICE_STAGE_DAYS,
  type ApiKeyExpirySnapshot,
} from '@/app/api/cron/api-key-expiry/route';
import { EXPIRATION_WARNING_MS } from '@/lib/apiKeyTypes';

// Helpers

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference for the pure-function tests

function snapshot(overrides: Partial<ApiKeyExpirySnapshot> = {}): ApiKeyExpirySnapshot {
  return {
    expiresAt: NOW + 30 * DAY, // comfortably outside the window by default
    rotatedAt: null,
    revokedAt: null,
    noticedStages: [],
    ...overrides,
  };
}

/**
 * A key document as the collection-group scan sees it. `ref.parent.parent.id` is
 * the ONLY claim of ownership a flat scan carries, so the stub models it exactly.
 */
function keyDoc(id: string, ownerUid: string, data: Record<string, unknown>) {
  const path = `users/${ownerUid}/api_keys/${id}`;
  return {
    id,
    data: () => data,
    ref: {
      path,
      parent: { parent: { id: ownerUid } },
      set: (payload: unknown, opts: unknown) => {
        callOrder.push(`stamp:${path}`);
        return refSet(path, payload, opts);
      },
    },
  };
}

function seed(docs: ReturnType<typeof keyDoc>[]) {
  mockQueryGet.mockResolvedValue({ size: docs.length, docs });
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/api-key-expiry', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

// Pure rung decision

describe('classifyApiKeyExpiry', () => {
  it('exposes the ladder as 0 / 3 / 14 days, widest rung pinned to the ui warning window', () => {
    expect(NOTICE_STAGE_DAYS).toEqual([0, 3, EXPIRATION_WARNING_MS / DAY]);
  });

  it('skips a key with no expiry', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: null }), NOW)).toEqual({
      action: 'skip',
      reason: 'no-expiry',
    });
  });

  it('skips a rotated key — its successor carries the live credential', () => {
    expect(
      classifyApiKeyExpiry(
        snapshot({ expiresAt: NOW + 2 * DAY, rotatedAt: NOW - DAY }),
        NOW
      )
    ).toEqual({ action: 'skip', reason: 'rotated' });
  });

  it('skips a REVOKED key — soft delete keeps it in the window forever', () => {
    // Load-bearing since revoke became a soft delete: the document is never
    // removed, so without this every revoked key nags until its expiresAt.
    expect(
      classifyApiKeyExpiry(
        snapshot({ expiresAt: NOW + 2 * DAY, revokedAt: NOW - DAY }),
        NOW
      )
    ).toEqual({ action: 'skip', reason: 'revoked' });
  });

  it('skips a future-dated revocation too (presence, not <= now)', () => {
    expect(
      classifyApiKeyExpiry(
        snapshot({ expiresAt: NOW + 2 * DAY, revokedAt: NOW + 10 * DAY }),
        NOW
      )
    ).toEqual({ action: 'skip', reason: 'revoked' });
  });

  // Upper boundary

  it('notifies at exactly 14 days out', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 14 * DAY }), NOW)).toEqual({
      action: 'notify',
      stage: 14,
      daysRemaining: 14,
    });
  });

  it('is out of window one millisecond before 14 days out', () => {
    expect(
      classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 14 * DAY + 1 }), NOW)
    ).toEqual({ action: 'skip', reason: 'out-of-window' });
  });

  // Rung boundaries

  it('keeps a key between rungs on the rung it already got (13 days -> 14)', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 13 * DAY }), NOW)).toEqual({
      action: 'notify',
      stage: 14,
      daysRemaining: 13,
    });
  });

  it('drops to the 3-day rung at exactly 3 days out', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 3 * DAY }), NOW)).toEqual({
      action: 'notify',
      stage: 3,
      daysRemaining: 3,
    });
  });

  it('is still the 14-day rung one millisecond above 3 days out', () => {
    expect(
      classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 3 * DAY + 1 }), NOW)
    ).toEqual({ action: 'notify', stage: 14, daysRemaining: 3 });
  });

  it('drops to the final rung at exactly expiry', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW }), NOW)).toEqual({
      action: 'notify',
      stage: 0,
      daysRemaining: 0,
    });
  });

  it('is still the 3-day rung one millisecond before expiry', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW + 1 }), NOW)).toEqual({
      action: 'notify',
      stage: 3,
      daysRemaining: 0,
    });
  });

  // Lower boundary

  it('still notifies a key that expired within the last day', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW - 12 * 60 * 60 * 1000 }), NOW)).toEqual({
      action: 'notify',
      stage: 0,
      daysRemaining: -1,
    });
  });

  it('is out of window at exactly one day past expiry', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW - DAY }), NOW)).toEqual({
      action: 'skip',
      reason: 'out-of-window',
    });
  });

  it('ignores a long-expired key rather than re-reading it every day', () => {
    expect(classifyApiKeyExpiry(snapshot({ expiresAt: NOW - 90 * DAY }), NOW)).toEqual({
      action: 'skip',
      reason: 'out-of-window',
    });
  });

  // Dedupe

  it('skips a rung already stamped', () => {
    expect(
      classifyApiKeyExpiry(
        snapshot({ expiresAt: NOW + 10 * DAY, noticedStages: [14] }),
        NOW
      )
    ).toEqual({ action: 'skip', reason: 'already-noticed' });
  });

  it('still fires the next rung down once the key crosses it', () => {
    expect(
      classifyApiKeyExpiry(
        snapshot({ expiresAt: NOW + 2 * DAY, noticedStages: [14] }),
        NOW
      )
    ).toEqual({ action: 'notify', stage: 3, daysRemaining: 2 });
  });
});

// GET handler wiring

describe('GET /api/cron/api-key-expiry', () => {
  const originalSecret = process.env.CRON_SECRET;
  const now = Date.now();

  /**
   * `expiresAt` n whole days out, plus a minute of slack: the route reads its own
   * `Date.now()` after this file computed `now`, and an exact multiple of a day
   * would floor to n-1 on that drift.
   */
  const inDays = (n: number) => now + n * DAY + 60_000;

  beforeEach(() => {
    jest.clearAllMocks();
    callOrder = [];
    process.env.CRON_SECRET = 'cron-secret';
    seed([]);
    emailSend.mockImplementation(async (payload: { to: string[] }) => {
      callOrder.push(`send:${payload.to[0]}`);
      return { error: null };
    });
    getUserAlertRecipientMock.mockImplementation(async (userId: string) => ({
      userId,
      email: `${userId}@owlette.test`,
      ccEmails: [],
    }));
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a request without the cron secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockQueryGet).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong cron secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockQueryGet).not.toHaveBeenCalled();
  });

  it('scans one field with two range filters — no equality on a nullable field', async () => {
    // An `== null` filter is what made functions/src/apiKeyExpire.ts inert; this
    // route must never grow one.
    await GET(request('cron-secret'));
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls.map(([field, op]) => [field, op])).toEqual([
      ['expiresAt', '>='],
      ['expiresAt', '<='],
    ]);
    expect(whereCalls.every(([, op]) => op !== '==')).toBe(true);
  });

  it('stamps the rung BEFORE sending, and reports its counters', async () => {
    seed([
      keyDoc('k1', 'u1', {
        name: 'ci-deploy',
        keyPrefix: 'owk_live_abc1234',
        expiresAt: inDays(2),
      }),
    ]);

    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      keysScanned: 1,
      usersNotified: 1,
      emailsSent: 1,
    });

    expect(refSet).toHaveBeenCalledWith(
      'users/u1/api_keys/k1',
      { expiryNoticedStages: [3] },
      { merge: true }
    );
    expect(callOrder).toEqual(['stamp:users/u1/api_keys/k1', 'send:u1@owlette.test']);
  });

  it('appends to the existing rungs instead of replacing them', async () => {
    seed([
      keyDoc('k1', 'u1', {
        name: 'ci-deploy',
        keyPrefix: 'owk_live_abc1234',
        expiresAt: inDays(2),
        expiryNoticedStages: [14],
      }),
    ]);

    await GET(request('cron-secret'));
    expect(refSet).toHaveBeenCalledWith(
      'users/u1/api_keys/k1',
      { expiryNoticedStages: [14, 3] },
      { merge: true }
    );
  });

  it('sends ONE email per owner listing all of that owner’s expiring keys', async () => {
    seed([
      keyDoc('k1', 'u1', { name: 'ci-deploy', keyPrefix: 'owk_live_aaa1111', expiresAt: inDays(2) }),
      keyDoc('k2', 'u1', { name: 'grafana', keyPrefix: 'owk_live_bbb2222', expiresAt: inDays(12) }),
      keyDoc('k3', 'u2', { name: 'edge-agent', keyPrefix: 'owk_live_ccc3333', expiresAt: inDays(1) }),
    ]);

    const res = await GET(request('cron-secret'));
    expect(await res.json()).toMatchObject({ keysScanned: 3, usersNotified: 2, emailsSent: 2 });
    expect(emailSend).toHaveBeenCalledTimes(2);

    const first = emailSend.mock.calls[0][0];
    expect(first.to).toEqual(['u1@owlette.test']);
    expect(first.subject).toBe('2 api keys expiring');
    expect(first.html).toContain('ci-deploy');
    expect(first.html).toContain('grafana');
    expect(first.html).not.toContain('edge-agent');

    const second = emailSend.mock.calls[1][0];
    expect(second.to).toEqual(['u2@owlette.test']);
    expect(second.subject).toBe('api key "edge-agent" expires in 1 day(s)');
  });

  it('carries a per-recipient unsubscribe link and the owner’s cc list', async () => {
    getUserAlertRecipientMock.mockResolvedValue({
      userId: 'u1',
      email: 'u1@owlette.test',
      ccEmails: ['ops@owlette.test'],
    });
    seed([keyDoc('k1', 'u1', { name: 'ci-deploy', keyPrefix: 'owk_live_aaa1111', expiresAt: inDays(2) })]);

    await GET(request('cron-secret'));
    const sent = emailSend.mock.calls[0][0];
    expect(sent.cc).toEqual(['ops@owlette.test']);
    expect(sent.html).toContain('/api/unsubscribe?token=unsub-u1');
    // 'unsubscribeUrl' in options is what marks an alert email at all.
    expect(sent.html).toContain('manage alerts');
  });

  it('never puts the key hash or its scopes in the email body', async () => {
    seed([
      keyDoc('k1', 'u1', {
        name: 'ci-deploy',
        keyPrefix: 'owk_live_aaa1111',
        expiresAt: inDays(2),
        keyHash: 'deadbeefcafe0123456789abcdef',
        scopes: [{ resource: 'site', id: 'scope-id-must-not-leak', permissions: ['admin'] }],
      }),
    ]);

    await GET(request('cron-secret'));
    const { html } = emailSend.mock.calls[0][0];
    expect(html).not.toContain('deadbeefcafe0123456789abcdef');
    expect(html).not.toContain('scope-id-must-not-leak');
    expect(html).not.toContain('permissions');
  });

  it('skips a rotated key, a revoked key and an already-stamped key without sending', async () => {
    seed([
      keyDoc('rot', 'u1', { name: 'rotated', keyPrefix: 'owk_live_r', expiresAt: inDays(2), rotatedAt: now - DAY }),
      keyDoc('rev', 'u1', { name: 'revoked', keyPrefix: 'owk_live_v', expiresAt: inDays(2), revokedAt: now - DAY }),
      keyDoc('done', 'u1', { name: 'noticed', keyPrefix: 'owk_live_d', expiresAt: inDays(2), expiryNoticedStages: [3] }),
    ]);

    const res = await GET(request('cron-secret'));
    expect(await res.json()).toEqual({ ok: true, keysScanned: 3, usersNotified: 0, emailsSent: 0 });
    expect(refSet).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('drops a key that expired well before the lower bound', async () => {
    seed([keyDoc('old', 'u1', { name: 'ancient', keyPrefix: 'owk_live_o', expiresAt: now - 90 * DAY })]);
    const res = await GET(request('cron-secret'));
    expect(await res.json()).toEqual({ ok: true, keysScanned: 1, usersNotified: 0, emailsSent: 0 });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('refuses to send when the resolved recipient is not the key’s owner', async () => {
    // The leakage guard. A collection-group scan returns every customer's keys
    // flat, so a grouping (or lookup) bug would mail one customer's key names to
    // another. Nothing is stamped either — the notice is still owed.
    getUserAlertRecipientMock.mockResolvedValue({
      userId: 'someone-else',
      email: 'someone-else@owlette.test',
      ccEmails: [],
    });
    seed([keyDoc('k1', 'u1', { name: 'ci-deploy', keyPrefix: 'owk_live_aaa1111', expiresAt: inDays(2) })]);

    const res = await GET(request('cron-secret'));
    expect(await res.json()).toEqual({ ok: true, keysScanned: 1, usersNotified: 1, emailsSent: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(refSet).not.toHaveBeenCalled();
  });

  it('sends nothing and stamps nothing for an owner who opted out', async () => {
    // A reversed opt-out should still get the remaining rungs, so the stamp must
    // not be burned while the preference is off.
    getUserAlertRecipientMock.mockResolvedValue(null);
    seed([keyDoc('k1', 'u1', { name: 'ci-deploy', keyPrefix: 'owk_live_aaa1111', expiresAt: inDays(2) })]);

    const res = await GET(request('cron-secret'));
    expect(getUserAlertRecipientMock).toHaveBeenCalledWith('u1', 'apiKeyAlerts');
    expect(await res.json()).toEqual({ ok: true, keysScanned: 1, usersNotified: 1, emailsSent: 0 });
    expect(refSet).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('counts a Resend error as not sent, and keeps going for the next owner', async () => {
    emailSend
      .mockResolvedValueOnce({ error: { message: 'rate limited' } })
      .mockResolvedValueOnce({ error: null });
    seed([
      keyDoc('k1', 'u1', { name: 'a', keyPrefix: 'owk_live_a', expiresAt: inDays(2) }),
      keyDoc('k2', 'u2', { name: 'b', keyPrefix: 'owk_live_b', expiresAt: inDays(2) }),
    ]);

    const res = await GET(request('cron-secret'));
    expect(await res.json()).toEqual({ ok: true, keysScanned: 2, usersNotified: 2, emailsSent: 1 });
  });

  it('returns a 500 problem response when the scan throws', async () => {
    mockQueryGet.mockRejectedValue(new Error('firestore unavailable'));
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(500);
    expect(emailSend).not.toHaveBeenCalled();
  });
});
