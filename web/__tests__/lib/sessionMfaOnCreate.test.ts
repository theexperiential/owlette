/** @jest-environment node */

/**
 * Unit tests for the PURE session-create MFA decision helper
 * (`resolveMfaOnSessionCreate` in `lib/sessionManager.server.ts`).
 *
 * This helper is deliberately extracted from `createSession` precisely because
 * `createSession` cannot be unit-tested end-to-end — there is no iron-session
 * mock anywhere in the repo. The helper carries all of the plan's Decision 1
 * branching (mfaRequired is always fresh; the preserve rule; the passkey-uv
 * birth path; the device-trust birth path) with zero I/O, so it can be
 * exercised directly with plain objects and no mocks.
 *
 * `@/lib/firebase-admin` is stubbed only to keep the transitive module import
 * (sessionManager.server → deviceTrust.server → firebase-admin) hermetic; the
 * pure helper never touches it.
 */

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

import { resolveMfaOnSessionCreate } from '@/lib/sessionManager.server';

const NOW = 1_700_000_000_000;
const USER = 'user-1';
const PREV_COMPLETED_AT = NOW - 5_000;

/** A prior session that DOES satisfy the preserve rule (real challenge, live). */
function preservablePrev(
  overrides: Record<string, unknown> = {}
): {
  userId?: string;
  expiresAt?: number;
  mfaRequired?: boolean;
  mfaVerified?: boolean;
  mfaCompletedAt?: number;
} {
  return {
    userId: USER,
    expiresAt: NOW + 60_000, // unexpired
    mfaRequired: true,
    mfaVerified: true,
    mfaCompletedAt: PREV_COMPLETED_AT,
    ...overrides,
  };
}

const REQUIRED = { mfaRequired: true, mfaVerified: false };
const NOT_REQUIRED = { mfaRequired: false, mfaVerified: true };

describe('resolveMfaOnSessionCreate', () => {
  describe('preserve branch (required + prior verified challenge)', () => {
    it('preserves verified state and carries mfaCompletedAt from prev', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: PREV_COMPLETED_AT,
      });
    });

    it('takes precedence over device trust (completion time from prev, not now)', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true, // both preserve AND trust would apply
      });
      expect(out.mfaVerified).toBe(true);
      expect(out.mfaCompletedAt).toBe(PREV_COMPLETED_AT);
      expect(out.mfaCompletedAt).not.toBe(NOW);
    });
  });

  describe('preserve rejected — each condition violated independently', () => {
    // With required + untrusted, a rejected preserve must fall through to the
    // challenge (verified:false, no completion timestamp).
    const expectChallenge = (prev: ReturnType<typeof preservablePrev>) => {
      const out = resolveMfaOnSessionCreate({
        prev,
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    };

    it('rejects a different uid', () => {
      expectChallenge(preservablePrev({ userId: 'someone-else' }));
    });

    it('rejects an expired prior session (expiresAt <= now)', () => {
      expectChallenge(preservablePrev({ expiresAt: NOW })); // boundary: not > now
      expectChallenge(preservablePrev({ expiresAt: NOW - 1 }));
    });

    it('rejects a missing / non-number expiresAt', () => {
      expectChallenge(preservablePrev({ expiresAt: undefined }));
      expectChallenge(
        preservablePrev({ expiresAt: 'nope' as unknown as number })
      );
    });

    it('rejects prev.mfaRequired === false (the post-disable case)', () => {
      // Post-disable sessions carry mfaRequired=false, mfaVerified=true; they
      // must NOT preserve into a newly-required session.
      expectChallenge(preservablePrev({ mfaRequired: false }));
    });

    it('rejects prev.mfaVerified === false', () => {
      expectChallenge(preservablePrev({ mfaVerified: false }));
    });
  });

  describe('device-trust birth path (required, preserve inapplicable)', () => {
    it('births verified with mfaCompletedAt = now when the device is trusted', () => {
      const out = resolveMfaOnSessionCreate({
        // Preserve inapplicable (different uid) so the trust branch is reached.
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
      });
    });
  });

  describe('required, no preserve, untrusted → challenge', () => {
    it('is unverified with no completion timestamp', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {}, // empty prior session — nothing to preserve
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    });
  });

  describe('not-required branch (resolved.mfaRequired === false)', () => {
    it('is verified with NO completion timestamp, regardless of prev/trust', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(), // would preserve if it mattered
        resolved: NOT_REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true, // would trust if it mattered
      });
      expect(out).toEqual({ mfaRequired: false, mfaVerified: true });
      expect(out.mfaCompletedAt).toBeUndefined();
    });
  });

  // A user-verified passkey ceremony completed by the calling route satisfies
  // MFA in one step. These lock in both halves of that: the new birth path
  // works, and every pre-existing path stays byte-identical.
  describe('mfaSatisfiedBy: passkey-uv', () => {
    it('births a required session verified with mfaCompletedAt = now', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {}, // nothing to preserve — the passkey input is doing the work
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
      });
    });

    it('is the only difference: the same input without it still challenges', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {},
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    });

    it('never flips mfaRequired — a not-required account resolves unchanged', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {},
        resolved: NOT_REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      // Still not required, and still NO completion timestamp: the
      // not-required branch short-circuits before passkey-uv is consulted.
      expect(out).toEqual({ mfaRequired: false, mfaVerified: true });
      expect(out.mfaCompletedAt).toBeUndefined();
    });

    it('does not disturb the preserve path (prev completion time still wins)', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: PREV_COMPLETED_AT,
      });
      expect(out.mfaCompletedAt).not.toBe(NOW);
    });

    it('does not disturb the device-trust path (same output with or without it)', () => {
      // Preserve inapplicable (different uid) so the birth paths are reached.
      const both = resolveMfaOnSessionCreate({
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
        mfaSatisfiedBy: 'passkey-uv',
      });
      const trustOnly = resolveMfaOnSessionCreate({
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
      });
      expect(both).toEqual(trustOnly);
      expect(both).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
      });
    });
  });
});
