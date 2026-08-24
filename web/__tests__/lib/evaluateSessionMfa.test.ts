/** @jest-environment node */

/**
 * `evaluateSessionMfa` — the proxy's per-request MFA read.
 *
 * The COST matters as much as the answer: this runs on every non-`/api` request, so
 * `requiresMfaSetup` must come from the session cookie, not Firestore. Every test asserts on
 * `firestoreReads` too. Sessions issued before a field existed are the interesting case — they
 * are the whole live population on ship day.
 */

import { NextRequest } from 'next/server';

type MutableSession = Record<string, unknown> & {
  save: jest.Mock;
  destroy: jest.Mock;
};

let session: MutableSession;
let firestoreReads = 0;
let userDoc: { exists: boolean; data?: Record<string, unknown> };

jest.mock('iron-session', () => ({
  getIronSession: jest.fn(async () => session),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ get: () => undefined })),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => {
          firestoreReads += 1;
          return { exists: userDoc.exists, data: () => userDoc.data };
        },
      }),
    }),
  }),
}));

jest.mock('@/lib/deviceTrust.server', () => ({
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  findValidTrustedDevice: jest.fn(async () => false),
}));

import { evaluateSessionMfa } from '@/lib/sessionManager.server';

function makeSession(fields: Record<string, unknown>): MutableSession {
  return {
    userId: 'user-1',
    expiresAt: Date.now() + 60_000,
    ...fields,
    save: jest.fn(async () => {}),
    destroy: jest.fn(async () => {}),
  };
}

const request = () => new NextRequest(new URL('http://localhost/dashboard'));

beforeEach(() => {
  firestoreReads = 0;
  userDoc = { exists: true, data: { mfaEnrolled: false, requiresMfaSetup: true } };
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('evaluateSessionMfa — requiresSetup', () => {
  it('reads the cached flag off the session without touching Firestore', async () => {
    session = makeSession({
      mfaRequired: false,
      mfaVerified: true,
      requiresMfaSetup: true,
    });

    const result = await evaluateSessionMfa(request());

    expect(result).toEqual({
      outcome: 'pass',
      userId: 'user-1',
      requiresSetup: true,
    });
    expect(firestoreReads).toBe(0);
  });

  it('costs zero reads for a fully-stamped, enrolled, verified session', async () => {
    session = makeSession({
      mfaRequired: true,
      mfaVerified: true,
      requiresMfaSetup: false,
    });

    const result = await evaluateSessionMfa(request());

    expect(result.outcome).toBe('pass');
    expect(result.requiresSetup).toBe(false);
    expect(firestoreReads).toBe(0);
  });

  it('derives requiresSetup:false for an enrolled session missing the field — no read', async () => {
    // `mfaRequired === true` means enrolled, and the single writer keeps the flags inverse, so no
    // lookup is needed — which is what stops every pre-existing session paying a read per request.
    session = makeSession({ mfaRequired: true, mfaVerified: true });

    const result = await evaluateSessionMfa(request());

    expect(result.requiresSetup).toBe(false);
    expect(firestoreReads).toBe(0);
    expect(session.save).not.toHaveBeenCalled();
  });

  it('resolves the flag from Firestore once for a non-enrolled session missing it', async () => {
    session = makeSession({ mfaRequired: false, mfaVerified: true });

    const result = await evaluateSessionMfa(request());

    expect(result.requiresSetup).toBe(true);
    expect(firestoreReads).toBe(1);
    // Written back so the value is consistent for this request and durable once re-stamped.
    expect(session.requiresMfaSetup).toBe(true);
  });

  it('does not clobber a verified state when only the setup flag is missing', async () => {
    // Re-stamping a passed challenge from Firestore (which reports every enrolled account as
    // unverified) would silently re-challenge the user.
    userDoc = { exists: true, data: { mfaEnrolled: true, requiresMfaSetup: false } };
    session = makeSession({ mfaRequired: false, mfaVerified: true });

    const result = await evaluateSessionMfa(request());

    expect(result.outcome).toBe('pass');
    expect(session.mfaRequired).toBe(false);
    expect(session.mfaVerified).toBe(true);
  });

  it('never reports requiresSetup for an account Firestore says is enrolled', async () => {
    // Both flags true: setup outranks the challenge in the proxy, so an enrolled account must not
    // be diverted into mandatory setup by a stale flag.
    userDoc = { exists: true, data: { mfaEnrolled: true, requiresMfaSetup: true } };
    session = makeSession({ mfaRequired: false, mfaVerified: true });

    const result = await evaluateSessionMfa(request());

    expect(result.requiresSetup).toBe(false);
  });

  it('upgrades a pre-Wave-2 session (both fields missing) in one read', async () => {
    session = makeSession({});

    const result = await evaluateSessionMfa(request());

    expect(firestoreReads).toBe(1);
    expect(result.outcome).toBe('pass');
    expect(result.requiresSetup).toBe(true);
  });

  it('still forces the challenge fail-closed when a pre-Wave-2 lookup throws', async () => {
    userDoc = {
      get exists(): boolean {
        throw new Error('firestore down');
      },
    } as unknown as typeof userDoc;
    session = makeSession({});

    const result = await evaluateSessionMfa(request());

    expect(result.outcome).toBe('challenge');
    expect(result.requiresSetup).toBe(false);
  });

  it('honours the cached challenge state — not a forced challenge — when only the setup lookup throws', async () => {
    // Only `mfaRequired === false` sessions reach the setup-only lookup, and their cached
    // challenge state is authoritative, so it is used as-is. Fail-closed on the challenge still
    // applies to sessions with no cached state; the setup flag is a policy gate whose unknown-case
    // is the pre-existing behaviour — better than diverting users into setup on a Firestore blip.
    userDoc = {
      get exists(): boolean {
        throw new Error('firestore down');
      },
    } as unknown as typeof userDoc;
    session = makeSession({ mfaRequired: false, mfaVerified: true });

    const result = await evaluateSessionMfa(request());

    expect(result.outcome).toBe('pass');
    expect(result.requiresSetup).toBe(false);
  });

  it('reports no setup requirement for an unauthenticated session', async () => {
    session = makeSession({ userId: undefined, expiresAt: undefined });

    const result = await evaluateSessionMfa(request());

    expect(result).toEqual({
      outcome: 'unauthenticated',
      userId: null,
      requiresSetup: false,
    });
    expect(firestoreReads).toBe(0);
  });
});
