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
 */

const mockRequireSession = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockDecrypt = jest.fn();
const mockIsEncryptionConfigured = jest.fn();
const mockMarkSessionMfaDisabled = jest.fn();
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
let userData: Record<string, unknown> | null;
const updateCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
let runTransactionFn:
  | ((cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>)
  | null = null;

function makeUserRef() {
  const path = 'users/user-1';
  return {
    path,
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

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: () =>
        name === 'users' ? makeUserRef() : { get: async () => ({ exists: false }) },
    }),
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => {
      if (runTransactionFn) return runTransactionFn(cb);
      // Default: emulate a tx by passing in a tx object that mirrors the
      // user doc and applies update() against userData.
      const tx = {
        get: async () => ({
          exists: userData !== null,
          data: () => userData ?? undefined,
        }),
        update: (_ref: unknown, payload: Record<string, unknown>) => {
          if (userData) userData = { ...userData, ...payload };
          updateCalls.push({ path: 'users/user-1', payload });
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
  updateCalls.length = 0;
  runTransactionFn = null;

  mockRequireSession.mockResolvedValue('user-1');
  mockIsEncryptionConfigured.mockReturnValue(true);
  mockDecrypt.mockReturnValue('TOTP_SECRET');
  mockVerifyTOTP.mockReturnValue(true);
  mockVerifyBackupCode.mockReturnValue(false);
  mockMarkSessionMfaDisabled.mockResolvedValue(undefined);
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

  it('returns 404 when the user doc does not exist', async () => {
    userData = null;
    const res = await POST(disableReq({ code: '123456' }));
    expect(res.status).toBe(404);
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
      requiresMfaSetup: false,
    });

    // Session must be re-minted so the user isn't bounced to /verify-2fa.
    expect(mockMarkSessionMfaDisabled).toHaveBeenCalledTimes(1);

    // Audit row written tagged mfa_disabled.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.attributes.verb).toBe('mfa_disabled');
    expect(audit.attributes.factorUsed).toBe('totp');
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
