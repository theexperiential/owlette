/** @jest-environment node */

/**
 * `/api/mfa/factors` — the read-only inventory the account-settings security
 * panel renders.
 *
 * Three properties are worth pinning down, and they are the three that would
 * hurt if they regressed:
 *
 *   1. **The uid comes from the session.** The route takes no parameters at
 *      all, so no `?userId=` (or body field) can point it at another account.
 *   2. **No secret ever reaches the response.** `mfaSecret`, the hashed
 *      `backupCodes` and the stored credential public keys all live on the
 *      documents this route reads; a careless spread would ship them to the
 *      browser.
 *   3. **A legacy user document still reports TOTP.** Accounts written before
 *      `mfaFactors` existed only have `mfaEnrolled: true`. `normalizeMfaFactors`
 *      is deliberately NOT mocked here so that fallback is exercised for real
 *      rather than asserted against a stub that always agrees.
 */

const mockRequireSession = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockGetSessionData = jest.fn();
const mockGetPasskeyListInfo = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  // Defined inline because the factory is hoisted ABOVE module-scope code
  // by jest — top-level classes aren't yet initialised here.
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiAuthError,
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionData: (...a: unknown[]) => mockGetSessionData(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  getPasskeyListInfo: (...a: unknown[]) => mockGetPasskeyListInfo(...a),
}));

// `lib/mfaFactors.server.ts` is left real (see the header) — it only needs the
// admin handle to exist at import time, never to be called on this path.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    throw new Error('mfa/factors must not touch Firestore directly');
  },
}));

import { GET } from '@/app/api/mfa/factors/route';
import { createMockRequest } from '../helpers/utils';
import { ApiAuthError } from '@/lib/apiAuth.server';

const USER_ID = 'user-1';

const PASSKEY = {
  credentialId: 'cred-1',
  friendlyName: 'MacBook',
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: '2026-01-02T03:04:05.000Z',
  lastUsedAt: '2026-02-03T04:05:06.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSession.mockResolvedValue(USER_ID);
  mockAssertActiveUser.mockResolvedValue({});
  mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaVerified: false });
  mockGetPasskeyListInfo.mockResolvedValue([]);
});

describe('GET /api/mfa/factors', () => {
  it('reports both legs and derives the uid from the session, not the query', async () => {
    mockAssertActiveUser.mockResolvedValue({
      mfaFactors: { totp: true, passkeys: 1 },
      mfaEnrolledAt: { toDate: () => new Date('2026-03-04T05:06:07.000Z') },
    });
    mockGetPasskeyListInfo.mockResolvedValue([PASSKEY]);

    // A hostile `userId` in the query string must be ignored outright.
    const res = await GET(
      createMockRequest('/api/mfa/factors?userId=someone-else'),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireSession).toHaveBeenCalledTimes(1);
    expect(mockGetPasskeyListInfo).toHaveBeenCalledWith(USER_ID);
    expect(body.totp).toEqual({
      enrolled: true,
      enrolledAt: '2026-03-04T05:06:07.000Z',
    });
    expect(body.passkeys).toEqual([PASSKEY]);
    expect(body.totalFactors).toBe(2);
  });

  it('counts passkeys from the list, not the denormalized tally', async () => {
    // A stale counter must never win over the rows the user can actually see.
    mockAssertActiveUser.mockResolvedValue({ mfaFactors: { totp: false, passkeys: 7 } });
    mockGetPasskeyListInfo.mockResolvedValue([PASSKEY]);

    const body = await (await GET(createMockRequest('/api/mfa/factors'))).json();

    expect(body.passkeys).toHaveLength(1);
    expect(body.totalFactors).toBe(1);
  });

  it('falls back to mfaEnrolled for a document written before mfaFactors', async () => {
    mockAssertActiveUser.mockResolvedValue({ mfaEnrolled: true });

    const body = await (await GET(createMockRequest('/api/mfa/factors'))).json();

    expect(body.totp.enrolled).toBe(true);
    expect(body.totp.enrolledAt).toBeNull();
    expect(body.totalFactors).toBe(1);
  });

  it('never returns a secret, a hashed backup code, or a public key', async () => {
    mockAssertActiveUser.mockResolvedValue({
      mfaFactors: { totp: true, passkeys: 0 },
      mfaSecret: 'iv:ciphertext',
      backupCodes: ['$2a$10$hashedbackupcode'],
    });

    const raw = await (await GET(createMockRequest('/api/mfa/factors'))).text();

    expect(raw).not.toContain('iv:ciphertext');
    expect(raw).not.toContain('hashedbackupcode');
    expect(raw).not.toContain('mfaSecret');
    expect(raw).not.toContain('backupCodes');
    expect(raw).not.toContain('credentialPublicKey');
  });

  it('reports whether this session has already cleared a challenge', async () => {
    mockAssertActiveUser.mockResolvedValue({ mfaFactors: { totp: true, passkeys: 0 } });
    mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaVerified: true });

    const body = await (await GET(createMockRequest('/api/mfa/factors'))).json();

    expect(body.mfaVerified).toBe(true);
  });

  it('reports a zero-factor account as zero rather than erroring', async () => {
    mockAssertActiveUser.mockResolvedValue({});

    const body = await (await GET(createMockRequest('/api/mfa/factors'))).json();

    expect(body).toEqual({
      totp: { enrolled: false, enrolledAt: null },
      passkeys: [],
      totalFactors: 0,
      mfaVerified: false,
    });
  });

  it('propagates the auth failure status instead of masking it as a 500', async () => {
    mockRequireSession.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: No valid session'),
    );

    const res = await GET(createMockRequest('/api/mfa/factors'));

    expect(res.status).toBe(401);
    expect(mockGetPasskeyListInfo).not.toHaveBeenCalled();
  });
});
