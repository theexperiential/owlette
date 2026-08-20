/**
 * The factor-enrollment gate shared by every factor-enrollment route (TOTP and WebAuthn).
 *
 * WHY THIS EXISTS
 *
 * `/api/*` is not MFA-gated. `proxy.ts` returns early for any `/api` path
 * (it only stamps the security-version header), and `requireSessionUser`
 * checks uid equality — never `mfaVerified`. Up to now that was survivable
 * because enrolling a factor could not satisfy the gate: `mfaEnrolled` was
 * TOTP-only, and verify-setup refused re-enrollment outright.
 *
 * Universal 2FA changes that. A newly enrolled factor DOES satisfy the gate,
 * which turns every enrollment route into an MFA bypass:
 *
 *   ACTOR      someone holding the victim's `__session` cookie, or a few
 *              minutes at an unattended browser parked on /verify-2fa.
 *   MECHANISM  POST /api/mfa/setup, then /api/mfa/verify-setup with a code
 *              from the attacker's own authenticator app.
 *   OUTCOME    full MFA bypass from a session cookie alone, plus a permanent
 *              attacker-controlled factor on the victim's account.
 *
 * THE RULE (identical for every factor-enrollment route):
 *
 *   - zero factors currently enrolled -> enrollment is OPEN. This is the
 *     mandatory-setup path: a user who has never enrolled cannot possibly
 *     hold `mfaVerified`, so gating here would be an unresolvable deadlock.
 *   - one or more factors already     -> the session must have cleared a
 *     challenge (`mfaVerified === true`), else 403 `mfa_challenge_required`.
 *
 * The caller gets the inventory back so it can make per-factor decisions
 * (verify-setup still refuses to overwrite an existing TOTP secret) without
 * paying for a second read of the user document.
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
   * The response to return immediately, or `null` when enrollment may
   * proceed. Callers must `if (gate.denied) return gate.denied;` before any
   * side effect — the gate itself writes nothing.
   */
  denied: NextResponse | null;
}

/**
 * Evaluate the enrollment gate for `userId`.
 *
 * Deliberately reads the inventory through `readMfaFactors` rather than the
 * raw `mfaEnrolled` boolean: legacy documents predate `mfaFactors`, and the
 * healing path there is what stops a passkey-holding account from reading as
 * zero-factor (i.e. the gate failing OPEN) before the backfill has run.
 */
export async function checkMfaEnrollmentGate(
  userId: string,
  precomputedFactors?: MfaFactorInventory,
): Promise<MfaEnrollmentGateResult> {
  // Callers that have ALREADY read the user document and the credential list
  // (the WebAuthn register routes do both before they can build
  // `excludeCredentials`) pass the inventory in, so the gate costs them no
  // extra Firestore round-trip. Everyone else gets the healing read below.
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
