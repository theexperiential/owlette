/** @jest-environment node */

/**
 * The factor-enrollment gate on the TOTP routes (`/api/mfa/setup` and
 * `/api/mfa/verify-setup`).
 *
 * `/api/*` is not MFA-gated — `proxy.ts` returns early for any `/api` path and
 * `requireSessionUser` only checks uid equality. Once a freshly enrolled
 * factor can satisfy the MFA gate (universal 2FA), that makes every enrollment
 * route an MFA bypass for anyone holding the victim's `__session` cookie: add
 * an attacker-controlled factor, then step up with it.
 *
 * The rule these tests pin down:
 *   - zero factors  -> enrollment OPEN (the mandatory-setup path; a user who
 *     has never enrolled can never hold `mfaVerified`, so gating here would
 *     deadlock them out of ever enrolling).
 *   - any factor    -> `mfaVerified === true` required, else 403
 *     `mfa_challenge_required`.
 *
 * Plus the per-factor rule that replaced verify-setup's old blanket
 * `mfaEnrolled === true` 409: a passkey-only account may ADD TOTP, but a live
 * TOTP secret is never overwritten in place (disable-then-enroll only).
 */

const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockGetSessionData = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockReadMfaFactors = jest.fn();
const mockApplyMfaFactorChange = jest.fn();
const mockEmitMutation = jest.fn();
const mockGenerateTOTPSecret = jest.fn();
const mockGenerateQRCode = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockHashBackupCode = jest.fn();
const mockPendingSet = jest.fn();
const mockPendingDelete = jest.fn();

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
    requireSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionData: (...a: unknown[]) => mockGetSessionData(...a),
  markSessionMfaVerified: (...a: unknown[]) => mockMarkSessionMfaVerified(...a),
}));

// The inventory module is stubbed here on purpose: these tests are about the
// GATE's decision, not the denormalization (covered by mfaFactors.test.ts and,
// end-to-end through a route, by disable.test.ts). `deriveMfaEnrolled` keeps
// its real one-line semantics so the gate isn't tested against a fiction.
jest.mock('@/lib/mfaFactors.server', () => ({
  deriveMfaEnrolled: (inv: { totp: boolean; passkeys: number }) =>
    inv.totp || inv.passkeys > 0,
  readMfaFactors: (...a: unknown[]) => mockReadMfaFactors(...a),
  applyMfaFactorChange: (...a: unknown[]) => mockApplyMfaFactorChange(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

jest.mock('@/lib/totp', () => ({
  generateTOTPSecret: (...a: unknown[]) => mockGenerateTOTPSecret(...a),
  generateQRCode: (...a: unknown[]) => mockGenerateQRCode(...a),
  verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
  hashBackupCode: (...a: unknown[]) => mockHashBackupCode(...a),
}));

jest.mock('@/lib/encryption.server', () => ({
  encrypt: (v: string) => `enc(${v})`,
  isEncryptionConfigured: () => true,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TIMESTAMP__' },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

/** The `mfa_pending/{uid}` document the setup step parks the secret in. */
let pendingDoc: Record<string, unknown> | null;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: pendingDoc !== null,
          data: () => pendingDoc ?? undefined,
        }),
        set: (...a: unknown[]) => mockPendingSet(...a),
        delete: (...a: unknown[]) => mockPendingDelete(...a),
      }),
    }),
  }),
}));

import { POST as SETUP } from '@/app/api/mfa/setup/route';
import { POST as VERIFY_SETUP } from '@/app/api/mfa/verify-setup/route';
import { createMockRequest } from '../helpers/utils';

const USER_ID = 'user-1';

beforeEach(() => {
  jest.clearAllMocks();

  // Default posture: brand-new account, session that has NOT cleared a
  // challenge. Each test tightens whichever leg it is about.
  mockRequireSessionUser.mockResolvedValue(USER_ID);
  mockAssertActiveUser.mockResolvedValue({});
  mockGetSessionData.mockResolvedValue({ userId: USER_ID });
  mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 0 });
  mockApplyMfaFactorChange.mockResolvedValue({
    factors: { totp: true, passkeys: 0 },
    mfaEnrolled: true,
    requiresMfaSetup: false,
  });
  mockGenerateTOTPSecret.mockReturnValue('SECRET');
  mockGenerateQRCode.mockResolvedValue('data:image/png;base64,QR');
  mockVerifyTOTP.mockReturnValue(true);
  mockHashBackupCode.mockImplementation((c: string) => `hash(${c})`);
  mockPendingSet.mockResolvedValue(undefined);
  mockPendingDelete.mockResolvedValue(undefined);

  pendingDoc = {
    secret: 'SECRET',
    email: 'user@example.com',
    expiresAt: { toDate: () => new Date(Date.now() + 5 * 60 * 1000) },
  };
});

function setupReq() {
  return createMockRequest('http://localhost/api/mfa/setup', {
    method: 'POST',
    body: { userId: USER_ID, email: 'user@example.com' },
  });
}

function verifySetupReq() {
  return createMockRequest('http://localhost/api/mfa/verify-setup', {
    method: 'POST',
    body: { userId: USER_ID, code: '123456', backupCodes: ['AAAA-BBBB'] },
  });
}

describe('POST /api/mfa/setup — enrollment gate', () => {
  it('is open for an account with no factor, even on an unverified session', async () => {
    // No pending secret yet — this is the real "starting setup" state. The
    // beforeEach seeds one for the verify-setup cases below, and leaving it in
    // place here would exercise the idempotent-reuse path instead of the mint.
    pendingDoc = null;

    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });

  // The route is idempotent by design: `app/setup-2fa/page.tsx` calls it from an
  // effect, so a refresh or remount issues a second POST. Minting a new secret
  // per call lets the LAST write win in `mfa_pending` while the user is looking
  // at a QR from an EARLIER response — verify-setup then rejects a code they
  // read correctly. That race made the setup-2fa e2e spec fail ~50% of runs.
  it('reuses an unexpired pending secret instead of minting a new one', async () => {
    const res = await SETUP(setupReq());

    expect(res.status).toBe(200);
    expect((await res.json()).secret).toBe('SECRET');
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('mints a fresh secret when the pending one has expired', async () => {
    pendingDoc = {
      secret: 'STALE',
      email: 'user@example.com',
      expiresAt: { toDate: () => new Date(Date.now() - 60 * 1000) },
    };

    const res = await SETUP(setupReq());

    expect(res.status).toBe(200);
    expect((await res.json()).secret).not.toBe('STALE');
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });

  it('returns 403 mfa_challenge_required when a factor already exists', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });

    const res = await SETUP(setupReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('mfa_challenge_required');
    // No pending secret is minted — the flow stops before any side effect.
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('lets an MFA-verified session add a second factor', async () => {
    pendingDoc = null;
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaVerified: true });

    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/mfa/verify-setup — enrollment gate', () => {
  it('completes first-time enrollment on an unverified session', async () => {
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);
    expect(mockApplyMfaFactorChange).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for a passkey-only account on an unverified session', async () => {
    // THE BYPASS THIS CLOSES: without the gate, narrowing the old blanket 409
    // to a per-factor check would let a stolen session bolt an
    // attacker-controlled TOTP factor onto any passkey-only account and then
    // step up with it.
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('mfa_challenge_required');
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
  });

  it('lets a verified passkey-only account add TOTP', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaVerified: true });

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    // The route hands the inventory module the factor delta plus the payload
    // to write atomically with it — and NEVER the two derived flags.
    const [userId, change, ctx] = mockApplyMfaFactorChange.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(change).toEqual({ totp: true });
    expect(ctx.extraUpdate).toMatchObject({
      mfaSecret: 'enc(SECRET)',
      backupCodes: ['hash(AAAA-BBBB)'],
      mfaEnrolledAt: '__SERVER_TIMESTAMP__',
    });
    expect(ctx.extraUpdate).not.toHaveProperty('mfaEnrolled');
    expect(ctx.extraUpdate).not.toHaveProperty('requiresMfaSetup');
  });

  it('still refuses to overwrite a live TOTP secret, verified or not', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: true, passkeys: 0 });
    mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaVerified: true });

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('mfa_already_enrolled');
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });
});

describe('POST /api/mfa/verify-setup — audit', () => {
  it('emits a user_mutated row recording the added factor', async () => {
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe(`user:${USER_ID}`);
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.attributes).toMatchObject({
      endpoint: '/api/mfa/verify-setup',
      method: 'POST',
      verb: 'mfa_enrolled',
      factor: 'totp',
      backupCodesIssued: 1,
    });
  });

  it('emits nothing when the TOTP code is wrong', async () => {
    mockVerifyTOTP.mockReturnValue(false);

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(400);
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });
});
