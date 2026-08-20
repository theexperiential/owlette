/** @jest-environment node */

/**
 * Tests for `/api/passkeys/register/verify` — the wave-2 factor-inventory,
 * enrollment-gate and first-factor session promotion behaviour.
 *
 * Three things have to hold:
 *
 *   1. FIRST factor. Enrolling a passkey on a zero-factor account flips
 *      `mfaEnrolled` true / `requiresMfaSetup` false (through
 *      `applyMfaFactorChange`, never a direct write) AND promotes the current
 *      session with `markSessionMfaVerified`. Without the promotion the very
 *      next AuthContext session-create bounces a passkey-only signup to
 *      /verify-2fa with nothing to present — a self-inflicted lockout.
 *   2. SUBSEQUENT factors do NOT re-promote. The promotion is the enrollment
 *      ceremony standing in for a challenge exactly once; after that a step-up
 *      must come from a real challenge.
 *   3. THE ENROLLMENT GATE. `/api/*` is not MFA-gated, so an unchallenged
 *      session on an account that ALREADY holds a factor must not be able to
 *      add an attacker-controlled credential and then step up with it: 403
 *      `mfa_challenge_required`, before the challenge is even consumed.
 *
 * `lib/mfaFactors.server.ts` is deliberately NOT mocked — the assertions are
 * about the fields that actually land on the user document, so the real
 * single-writer runs against the in-memory admin-SDK mock (the same store-backed
 * `getAdminDb` chain as `__tests__/lib/mfaFactors.test.ts`).
 */

// --- Mutable state backing the mocked admin SDK (reset in beforeEach). ---
let users: Map<string, Record<string, unknown>>;
let passkeys: Map<string, string[]>;

const setCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];

const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockGetSessionData = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockGetAndDeleteChallenge = jest.fn();
const mockStorePasskey = jest.fn();
const mockVerifyRegistrationResponse = jest.fn();
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
    requireSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionData: (...a: unknown[]) => mockGetSessionData(...a),
  markSessionMfaVerified: (...a: unknown[]) => mockMarkSessionMfaVerified(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'localhost',
  getExpectedOrigins: () => ['http://localhost:3000'],
  getAndDeleteChallenge: (...a: unknown[]) => mockGetAndDeleteChallenge(...a),
  storePasskey: (...a: unknown[]) => mockStorePasskey(...a),
}));

jest.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...a: unknown[]) =>
    mockVerifyRegistrationResponse(...a),
}));

jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { fromBuffer: () => 'public-key-b64url' },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

// Store-backed admin-SDK mock. The real `applyMfaFactorChange` runs on top of
// it, so the payload assertions below are the payload the route really writes.
function makePasskeyCollectionRef(uid: string) {
  return {
    get: async () => {
      const ids = passkeys.get(uid) ?? [];
      return {
        empty: ids.length === 0,
        size: ids.length,
        docs: ids.map((id) => ({ id, data: () => ({}) })),
      };
    },
  };
}

function makeUserDocRef(uid: string) {
  return {
    id: uid,
    get: async () => ({ exists: users.has(uid), data: () => users.get(uid) }),
    collection: (name: string) => {
      if (name !== 'passkeys') throw new Error(`unexpected subcollection: ${name}`);
      return makePasskeyCollectionRef(uid);
    },
  };
}

function makeTx() {
  return {
    get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
    set: (
      ref: { id: string },
      payload: Record<string, unknown>,
      options?: { merge?: boolean },
    ) => {
      setCalls.push({ id: ref.id, payload });
      const current = users.get(ref.id) ?? {};
      users.set(ref.id, options?.merge ? { ...current, ...payload } : { ...payload });
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
      return { doc: (uid: string) => makeUserDocRef(uid) };
    },
    runTransaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) =>
      fn(makeTx()),
  }),
}));

import { POST } from '@/app/api/passkeys/register/verify/route';
import { createMockRequest } from '../helpers/utils';

const UID = 'user-1';
const NEW_CREDENTIAL_ID = 'cred-new';

beforeEach(() => {
  jest.clearAllMocks();
  users = new Map([[UID, {}]]);
  passkeys = new Map([[UID, []]]);
  setCalls.length = 0;

  mockRequireSessionUser.mockResolvedValue(UID);
  mockAssertActiveUser.mockImplementation(async () => users.get(UID) ?? {});
  // Default: an unchallenged session. The zero-factor cases must pass anyway —
  // that is the mandatory-setup path the gate deliberately leaves open.
  mockGetSessionData.mockResolvedValue({ userId: UID, expiresAt: Date.now() + 1000 });
  mockMarkSessionMfaVerified.mockResolvedValue(undefined);
  mockGetAndDeleteChallenge.mockResolvedValue({
    challenge: 'challenge-1',
    userId: UID,
    type: 'registration',
  });
  // Mirror the real `storePasskey`: the credential lands in the subcollection,
  // which is what `recountPasskeys` reads back.
  mockStorePasskey.mockImplementation(async (uid: string, credential: { credentialId: string }) => {
    passkeys.set(uid, [...(passkeys.get(uid) ?? []), credential.credentialId]);
  });
  mockVerifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: NEW_CREDENTIAL_ID,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
    },
  });
});

function registerReq() {
  return createMockRequest('http://localhost/api/passkeys/register/verify', {
    method: 'POST',
    body: { userId: UID, credential: { id: NEW_CREDENTIAL_ID }, friendlyName: 'macbook' },
  });
}

/** The single inventory write the route makes, via `applyMfaFactorChange`. */
function inventoryWrite() {
  return setCalls.find((c) => 'mfaEnrolled' in c.payload);
}

describe('POST /api/passkeys/register/verify — first factor', () => {
  it('enrolls the first passkey, flips the inventory, and promotes the session', async () => {
    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, credentialId: NEW_CREDENTIAL_ID });

    // Inventory written by the single writer — not by this route.
    const write = inventoryWrite();
    expect(write).toBeTruthy();
    expect(write!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });

    // The enrollment ceremony stands in for a challenge exactly once.
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);

    // Audit row for the credential add.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.actor).toBe(`user:${UID}`);
    expect(audit.attributes).toMatchObject({
      verb: 'passkey_added',
      credentialId: NEW_CREDENTIAL_ID,
      passkeyCount: 1,
      firstFactor: true,
    });
  });

  it('counts the subcollection rather than trusting a stale stored tally', async () => {
    // A drifted document claiming zero passkeys while one really exists: the
    // recount must produce 2, not 1.
    users.set(UID, { mfaFactors: { totp: false, passkeys: 0 } });
    passkeys.set(UID, ['cred-old']);
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaVerified: true });

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
    });
  });
});

describe('POST /api/passkeys/register/verify — subsequent factors', () => {
  it('does not re-promote the session for a second passkey', async () => {
    users.set(UID, {
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    passkeys.set(UID, ['cred-old']);
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaVerified: true });

    const res = await POST(registerReq());
    expect(res.status).toBe(200);

    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
    expect(mockEmitMutation.mock.calls[0][0].attributes.firstFactor).toBe(false);
  });

  it('does not promote when TOTP already satisfies MFA', async () => {
    // Zero passkeys but a TOTP factor: this is the account's first PASSKEY and
    // still not its first FACTOR, so the session must not be promoted.
    users.set(UID, {
      mfaFactors: { totp: true, passkeys: 0 },
      mfaEnrolled: true,
    });
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaVerified: true });

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: true, passkeys: 1 },
      mfaEnrolled: true,
    });
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
  });
});

describe('POST /api/passkeys/register/verify — enrollment gate', () => {
  it('rejects an unverified session when a factor already exists', async () => {
    users.set(UID, {
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
    });
    passkeys.set(UID, ['cred-old']);
    // Session authenticated but never challenged.
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaRequired: true, mfaVerified: false });

    const res = await POST(registerReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');

    // Refused before the ceremony is consumed and before anything is persisted.
    expect(mockGetAndDeleteChallenge).not.toHaveBeenCalled();
    expect(mockStorePasskey).not.toHaveBeenCalled();
    expect(setCalls).toEqual([]);
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('rejects when there is no session data at all', async () => {
    users.set(UID, { mfaFactors: { totp: true, passkeys: 0 }, mfaEnrolled: true });
    mockGetSessionData.mockResolvedValue(null);

    const res = await POST(registerReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockStorePasskey).not.toHaveBeenCalled();
  });

  it('stays open for a zero-factor account on an unverified session', async () => {
    // The mandatory-setup path: no factor to challenge against, so enrollment
    // must not require one.
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaVerified: false });

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(mockStorePasskey).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);
  });
});
