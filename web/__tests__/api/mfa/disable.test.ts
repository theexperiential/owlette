/** @jest-environment node */

/**
 * Tests for the wave 2A `/api/mfa/disable` server-mediated MFA disable.
 *
 * The Firestore rules now lock the user-doc allowlist so the browser
 * cannot mutate mfaEnrolled / mfaSecret / backupCodes directly. This
 * route is the only authorized way to flip those fields, and it must:
 *   1. Require an authenticated session.
 *   2. Accept either a fresh TOTP code OR a backup code.
 *   3. Consume a used backup code inside a transaction (single-use even
 *      under concurrency — covered separately in verify-login.test.ts).
 *   4. Server-mediate the write (admin SDK bypass of the rule).
 *   5. Re-mint the session via markSessionMfaDisabled so the user isn't
 *      bounced to /verify-2fa on the next request.
 *   6. Emit a `user_mutated` audit row tagged `mfa_disabled`.
 *   7. Reject invalid TOTP / backup codes with a 400.
 *
 * Universal 2FA adds one more, and it is an INVERSION of the old behaviour:
 *   8. The route no longer writes `mfaEnrolled` / `requiresMfaSetup` itself —
 *      `applyMfaFactorChange` derives both from what the account is left with.
 *      Dropping the last factor is allowed and re-arms `requiresMfaSetup` to
 *      TRUE (it used to be forced to false); an account that still holds a
 *      passkey stays enrolled with the nag off.
 */

const mockRequireSession = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockDecrypt = jest.fn();
const mockIsEncryptionConfigured = jest.fn();
const mockMarkSessionMfaDisabled = jest.fn();
const mockRevokeAllTrustedDevices = jest.fn();
const mockEmitMutation = jest.fn();

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

jest.mock('@/lib/totp', () => ({
  verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
  verifyBackupCode: (...a: unknown[]) => mockVerifyBackupCode(...a),
}));

jest.mock('@/lib/encryption.server', () => ({
  decrypt: (...a: unknown[]) => mockDecrypt(...a),
  isEncryptionConfigured: (...a: unknown[]) => mockIsEncryptionConfigured(...a),
}));

jest.mock('@/lib/sessionManager.server', () => ({
  markSessionMfaDisabled: (...a: unknown[]) => mockMarkSessionMfaDisabled(...a),
}));

// jest.mock replaces the whole module, so the route's real
// `@/lib/deviceTrust.server` import MUST be stubbed here too — otherwise the
// route would pull in the Admin-SDK-backed implementation and every existing
// test would TypeError. `DEVICE_TRUST_COOKIE` / `deviceTrustCookieOptions`
// mirror the real values so the cookie-expiry assertions are meaningful.
jest.mock('@/lib/deviceTrust.server', () => ({
  revokeAllTrustedDevices: (...a: unknown[]) => mockRevokeAllTrustedDevices(...a),
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  deviceTrustCookieOptions: () => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => '__FIELD_DELETE__',
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
  },
}));

// Mutable doc store backing the mocked admin SDK.
//
// NOTE: `@/lib/mfaFactors.server` is deliberately NOT mocked. The whole point
// of this wave is that the route no longer writes `mfaEnrolled` /
// `requiresMfaSetup` itself — it delegates to the inventory module — so the
// tests have to run the real module against this fake Firestore. That means
// the fake must support what the module actually does: a transaction that
// reads the user doc, counts the `passkeys` subcollection when the stored
// inventory can't be trusted, and finishes with a single merge `set`.
let userData: Record<string, unknown> | null;
/** Size of `users/user-1/passkeys` — the other factor the account may hold. */
let passkeyCount = 0;
const updateCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
let runTransactionFn:
  | ((cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>)
  | null = null;

/** Ref marker so the fake `tx.get` can tell a doc read from a count read. */
const PASSKEYS_PATH = 'users/user-1/passkeys';

function makePasskeysRef() {
  return { path: PASSKEYS_PATH, get: async () => ({ size: passkeyCount }) };
}

function makeUserRef() {
  const path = 'users/user-1';
  return {
    path,
    id: 'user-1',
    collection: (name: string) =>
      name === 'passkeys' ? makePasskeysRef() : { path: `${path}/${name}` },
    get: async () => ({
      exists: userData !== null,
      data: () => userData ?? undefined,
    }),
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
      // Mirror writes onto the local user data for subsequent reads.
      if (userData) {
        userData = { ...userData, ...payload };
      }
    },
  };
}

/** Apply a write onto the local store and record it for assertions. */
function recordWrite(payload: Record<string, unknown>) {
  if (userData) userData = { ...userData, ...payload };
  updateCalls.push({ path: 'users/user-1', payload });
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: () =>
        name === 'users' ? makeUserRef() : { get: async () => ({ exists: false }) },
    }),
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => {
      if (runTransactionFn) return runTransactionFn(cb);
      // Default: emulate a tx that mirrors the user doc, answers
      // subcollection counts, and applies update()/set() against userData.
      const tx = {
        get: async (ref: { path?: string }) => {
          if (ref?.path === PASSKEYS_PATH) {
            return { size: passkeyCount };
          }
          return {
            exists: userData !== null,
            data: () => userData ?? undefined,
          };
        },
        update: (_ref: unknown, payload: Record<string, unknown>) => {
          recordWrite(payload);
        },
        set: (_ref: unknown, payload: Record<string, unknown>) => {
          recordWrite(payload);
        },
      };
      return cb(tx);
    },
  }),
}));

import { POST } from '@/app/api/mfa/disable/route';
import { createMockRequest } from '../helpers/utils';

beforeEach(() => {
  jest.clearAllMocks();
  userData = {
    mfaEnrolled: true,
    mfaSecret: 'iv:cipher', // encrypted secret form
    backupCodes: ['hash-bk-1', 'hash-bk-2', 'hash-bk-3'],
  };
  passkeyCount = 0;
  updateCalls.length = 0;
  runTransactionFn = null;

  mockRequireSession.mockResolvedValue('user-1');
  const { ApiAuthError } = jest.requireMock(
    '@/lib/apiAuth.server',
  ) as { ApiAuthError: new (status: number, message: string) => Error };
  mockAssertActiveUser.mockImplementation(async () => {
    if (userData === null) {
      throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive');
    }
    return userData;
  });
  mockIsEncryptionConfigured.mockReturnValue(true);
  mockDecrypt.mockReturnValue('TOTP_SECRET');
  mockVerifyTOTP.mockReturnValue(true);
  mockVerifyBackupCode.mockReturnValue(false);
  mockMarkSessionMfaDisabled.mockResolvedValue(undefined);
  mockRevokeAllTrustedDevices.mockResolvedValue(0);
});

function disableReq(body: unknown) {
  return createMockRequest('http://localhost/api/mfa/disable', {
    method: 'POST',
    body: body as Record<string, unknown>,
  });
}

describe('POST /api/mfa/disable — auth gate', () => {
  it('rejects with 401 when no session', async () => {
    // Build a fresh ApiAuthError-shaped error matching the mocked class.
    const err = new Error('Unauthorized') as Error & { status: number };
    // Match the mocked class's `instanceof` check by importing the same
    // module path the route does.
    const { ApiAuthError } = jest.requireMock(
      '@/lib/apiAuth.server',
    ) as { ApiAuthError: new (status: number, message: string) => Error };
    const realErr = new ApiAuthError(401, 'Unauthorized');
    mockRequireSession.mockRejectedValueOnce(realErr);

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(401);
    void err;
  });
});

describe('POST /api/mfa/disable — input validation', () => {
  it('returns 400 when code is missing', async () => {
    const res = await POST(disableReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when TOTP code is not exactly 6 digits', async () => {
    const res = await POST(disableReq({ code: '12345' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/6 digits/i);
  });

  it('returns 400 when MFA is not enrolled', async () => {
    userData = { mfaEnrolled: false };
    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not enrolled/i);
  });

  it('returns 403 when the active-user gate rejects a missing user doc', async () => {
    userData = null;
    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/mfa/disable — TOTP path', () => {
  it('accepts a valid TOTP code and tears down MFA fields', async () => {
    mockVerifyTOTP.mockReturnValue(true);

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.backupCodeUsed).toBe(false);

    // The user doc should have been updated with the teardown payload.
    const disablePayload = updateCalls.find(
      (c) => 'mfaEnrolled' in c.payload && c.payload.mfaEnrolled === false,
    );
    expect(disablePayload).toBeTruthy();
    expect(disablePayload!.payload).toMatchObject({
      mfaEnrolled: false,
      mfaSecret: '__FIELD_DELETE__',
      backupCodes: [],
      mfaFactors: { totp: false, passkeys: 0 },
      // INVERSION (universal 2FA): losing the last factor re-arms the
      // mandatory-setup nag. The route used to force this to false.
      requiresMfaSetup: true,
    });

    // Session must be re-minted so the user isn't bounced to /verify-2fa.
    expect(mockMarkSessionMfaDisabled).toHaveBeenCalledTimes(1);

    // Audit row written tagged mfa_disabled.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.attributes.verb).toBe('mfa_disabled');
    expect(audit.attributes.factor).toBe('totp');
    expect(audit.attributes.factorUsed).toBe('totp');
    expect(audit.attributes.stillEnrolled).toBe(false);
    expect(audit.attributes.setupReArmed).toBe(true);
  });

  it('rejects an invalid TOTP code with 400', async () => {
    mockVerifyTOTP.mockReturnValue(false);
    const res = await POST(disableReq({ code: '999999' }));
    expect(res.status).toBe(400);
    // Disable was NOT applied.
    expect(
      updateCalls.find(
        (c) => 'mfaEnrolled' in c.payload && c.payload.mfaEnrolled === false,
      ),
    ).toBeUndefined();
    expect(mockMarkSessionMfaDisabled).not.toHaveBeenCalled();
  });

  it('returns 500 when encryption is not configured but secret looks encrypted', async () => {
    mockIsEncryptionConfigured.mockReturnValue(false);
    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/mfa/disable — factor inventory', () => {
  it('re-arms requiresMfaSetup when TOTP was the account\'s last factor', async () => {
    passkeyCount = 0;

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const teardown = updateCalls.find((c) => 'mfaFactors' in c.payload);
    expect(teardown!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
  });

  it('keeps the account enrolled (nag off) when a passkey remains', async () => {
    passkeyCount = 2;

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);

    // Only the TOTP leg drops. The passkeys the account still holds keep
    // `mfaEnrolled` true, so the user is NOT pushed back into setup.
    const teardown = updateCalls.find((c) => 'mfaFactors' in c.payload);
    expect(teardown!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: '__FIELD_DELETE__',
      backupCodes: [],
    });

    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.attributes.passkeysEnrolled).toBe(2);
    expect(audit.attributes.stillEnrolled).toBe(true);
    expect(audit.attributes.setupReArmed).toBe(false);
  });

  it('trusts a well-formed stored inventory instead of recounting', async () => {
    // A backfilled document carries `mfaFactors`; the module must take the
    // passkeys leg from it rather than hitting the subcollection. The count
    // below is deliberately contradictory so a stray recount would show up.
    userData = {
      mfaEnrolled: true,
      mfaSecret: 'iv:cipher',
      backupCodes: ['hash-bk-1'],
      mfaFactors: { totp: true, passkeys: 1 },
    };
    passkeyCount = 99;

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const teardown = updateCalls.find((c) => 'mfaFactors' in c.payload);
    expect(teardown!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
  });
});

describe('POST /api/mfa/disable — backup-code path', () => {
  it('accepts a valid backup code, consumes it inside a transaction, and tears down MFA', async () => {
    // First call to verifyBackupCode (called for each stored hash) will
    // match the second stored hash to simulate finding the right code.
    mockVerifyBackupCode.mockImplementation((_code: string, hash: string) =>
      hash === 'hash-bk-2',
    );

    const res = await POST(
      disableReq({ code: 'AAAA-BBBB', isBackupCode: true }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.backupCodeUsed).toBe(true);

    // Transaction-side update consumed the used hash AND retained the
    // rest. (verifyBackupCode returned true for hash-bk-2 only.)
    const txConsumeWrite = updateCalls.find(
      (c) =>
        Array.isArray(c.payload.backupCodes) &&
        (c.payload.backupCodes as string[]).length === 2,
    );
    expect(txConsumeWrite).toBeTruthy();
    expect(txConsumeWrite!.payload.backupCodes).toEqual([
      'hash-bk-1',
      'hash-bk-3',
    ]);

    // The teardown write zeros out backupCodes entirely.
    const teardown = updateCalls.find(
      (c) => 'mfaEnrolled' in c.payload && c.payload.mfaEnrolled === false,
    );
    expect(teardown).toBeTruthy();
    expect(teardown!.payload.backupCodes).toEqual([]);

    expect(mockMarkSessionMfaDisabled).toHaveBeenCalledTimes(1);
    // Audit factor recorded as backup_code.
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.attributes.factorUsed).toBe('backup_code');
  });

  it('rejects an unknown backup code without consuming any', async () => {
    mockVerifyBackupCode.mockReturnValue(false);
    const res = await POST(
      disableReq({ code: 'WRONG-CODE', isBackupCode: true }),
    );
    expect(res.status).toBe(400);
    // No backupCodes mutation should have occurred.
    expect(
      updateCalls.find((c) => Array.isArray(c.payload.backupCodes)),
    ).toBeUndefined();
  });
});

describe('POST /api/mfa/disable — device trust revocation', () => {
  it('revokes all trusted devices for the session user and expires the trust cookie', async () => {
    mockRevokeAllTrustedDevices.mockResolvedValue(4);

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);

    // Trust records are purged for the session's OWN user (no userId param).
    expect(mockRevokeAllTrustedDevices).toHaveBeenCalledTimes(1);
    expect(mockRevokeAllTrustedDevices).toHaveBeenCalledWith('user-1');

    // The revoked count rides on the SINGLE existing audit emission — no
    // second emitMutation (audit invariant).
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.attributes.trustedDevicesRevoked).toBe(4);

    // The device-trust cookie is expired on the response.
    const cookie = res.cookies.get('owlette_device_trust');
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  it('still succeeds (200) and expires the cookie when revocation throws', async () => {
    mockRevokeAllTrustedDevices.mockRejectedValue(new Error('firestore down'));

    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // MFA was still torn down despite the revocation failure.
    expect(
      updateCalls.find(
        (c) => 'mfaEnrolled' in c.payload && c.payload.mfaEnrolled === false,
      ),
    ).toBeTruthy();
    expect(mockMarkSessionMfaDisabled).toHaveBeenCalledTimes(1);

    // Exactly one audit emission, with the fallback count of 0.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.attributes.trustedDevicesRevoked).toBe(0);

    // Cookie is still expired even though revocation threw.
    const cookie = res.cookies.get('owlette_device_trust');
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});
