/**
 * Enrollment gate shared by every factor-enrollment route (TOTP and WebAuthn).
 *
 * `/api/*` is not MFA-gated (proxy.ts returns early; `requireSessionUser` checks
 * uid only), so without this a stolen `__session` cookie could enroll its own
 * factor and clear the gate — a full MFA bypass plus a permanent attacker-owned
 * factor.
 *
 * The rule: zero factors -> enrollment OPEN (mandatory-setup path; gating would
 * deadlock a user who can never hold `mfaVerified`). One or more factors -> the
 * session must have cleared a challenge, else 403 `mfa_challenge_required`.
 *
 * The inventory is returned so callers can make per-factor decisions without a
 * second read of the user document.
 */

import { NextResponse } from 'next/server';
import {
  deriveMfaEnrolled,
  readMfaFactors,
  type MfaFactorInventory,
} from '@/lib/mfaFactors.server';
import { getSessionData } from '@/lib/sessionManager.server';

/** Machine-readable code the client keys off to send the user to /verify-2fa. */
export const MFA_CHALLENGE_REQUIRED = 'mfa_challenge_required';

export interface MfaEnrollmentGateResult {
  /** The account's current factor inventory, already read by the gate. */
  factors: MfaFactorInventory;
  /**
   * Response to return immediately, or `null` to proceed. Callers must
   * `if (gate.denied) return gate.denied;` before any side effect.
   */
  denied: NextResponse | null;
}

/**
 * Evaluate the enrollment gate for `userId`. Reads via `readMfaFactors`, not the
 * raw `mfaEnrolled` boolean: its healing path stops a legacy passkey-holding
 * account from reading zero-factor (the gate failing OPEN) pre-backfill.
 */
export async function checkMfaEnrollmentGate(
  userId: string,
  precomputedFactors?: MfaFactorInventory,
): Promise<MfaEnrollmentGateResult> {
  // WebAuthn register routes already read both docs to build
  // `excludeCredentials`, so they pass the inventory in and pay no extra read.
  const factors = precomputedFactors ?? (await readMfaFactors(userId));

  // No factor yet — mandatory setup. Enrollment must stay open.
  if (!deriveMfaEnrolled(factors)) {
    return { factors, denied: null };
  }

  const session = await getSessionData();
  if (session?.mfaVerified === true) {
    return { factors, denied: null };
  }

  return {
    factors,
    denied: NextResponse.json(
      {
        error:
          'this account already has a second factor. verify it first, then add another.',
        code: MFA_CHALLENGE_REQUIRED,
      },
      { status: 403 },
    ),
  };
}
