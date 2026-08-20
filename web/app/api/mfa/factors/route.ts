/**
 * MFA Factor Inventory API — read-only.
 *
 * The account-settings security panel needs to show a user WHAT second factors
 * they hold, not just whether the account is "2FA enabled". Before this route
 * the client could only see passkeys (`/api/passkeys/list`); the TOTP leg lives
 * on the user document, and `firestore.rules` does not hand those fields to the
 * browser. So the UI had no way to render a unified list, and TOTP and passkeys
 * read as unrelated features.
 *
 * GET /api/mfa/factors
 * Request: no parameters at all.
 * Response (200):
 *   {
 *     "totp":     { "enrolled": boolean, "enrolledAt": string | null },
 *     "passkeys": PasskeyInfo[],
 *     "totalFactors": number,
 *     "mfaVerified": boolean
 *   }
 *
 * `mfaVerified` mirrors what `checkMfaEnrollmentGate` will decide for this
 * session. Without it the UI can only discover the gate by taking a 403 — which
 * is fine for the in-page "add passkey" button but useless for "add
 * authenticator app", because that is a NAVIGATION to /setup-2fa and the 403
 * happens on a page the user has already left this dialog for. Reporting it
 * up front is what lets the panel offer a step-up first instead of dead-ending
 * them there. It is the caller's own session state and discloses nothing the
 * caller could not learn by making one gated request.
 *
 * Failure modes:
 *   - 401 no valid session.
 *   - 403 the user document is soft-deleted / inactive.
 *   - 429 rate limited (shared `auth` strategy, as the sibling MFA routes).
 *
 * SECURITY:
 *   - **Session-scoped, no `userId` parameter.** `/api/passkeys/list` still
 *     takes one (and checks it with `requireSessionUser`); a route that reports
 *     the shape of an account's 2FA has no reason to accept a target at all, so
 *     the uid comes from the session and from nowhere else. There is nothing to
 *     redirect against another account.
 *   - **No secrets cross the wire.** `mfaSecret` (even encrypted), the hashed
 *     `backupCodes`, and the stored credential public keys are all deliberately
 *     absent from the response. `getPasskeyListInfo` already projects to the
 *     metadata-only `PasskeyInfo`; the TOTP leg is reduced to a boolean plus a
 *     timestamp here. Any field added later must survive the same test: could
 *     it help an attacker who holds the response but not the account?
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { normalizeMfaFactors } from '@/lib/mfaFactors.server';
import { getSessionData } from '@/lib/sessionManager.server';
import { getPasskeyListInfo } from '@/lib/webauthn.server';

/**
 * `mfaEnrolledAt` is written with `FieldValue.serverTimestamp()` and comes back
 * as a Firestore `Timestamp`, but legacy documents predate the field entirely
 * and fixtures hand over a `Date` or epoch millis. Normalize all of those to an
 * ISO string (or null) rather than letting `JSON.stringify` emit a
 * `{_seconds, _nanoseconds}` blob the client would have to re-parse.
 */
function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const maybeTimestamp = value as { toDate?: unknown };
  if (typeof maybeTimestamp.toDate === 'function') {
    return (maybeTimestamp as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export const GET = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    const userData = await assertActiveUser(userId);

    const passkeys = await getPasskeyListInfo(userId);

    // The passkey leg is read from the LIST, not from the denormalized
    // `mfaFactors.passkeys` counter: this is the surface the user manages
    // credentials on, so the rows they can see and the count beside them must
    // be the same fact. `normalizeMfaFactors` still resolves the TOTP leg,
    // because it carries the legacy fallback (`mfaEnrolled === true` on a
    // document written before `mfaFactors` existed) that a raw field read would
    // miss. Handing it the real length also means the healed inventory it
    // returns can never be wrong about passkeys.
    const factors = normalizeMfaFactors(userData, passkeys.length);

    // Read straight from the session cookie rather than re-deriving the gate:
    // `checkMfaEnrollmentGate` keys off exactly this flag, so anything cleverer
    // here would be a second implementation of the gate that could disagree
    // with it.
    const session = await getSessionData();

    return NextResponse.json({
      totp: {
        enrolled: factors.totp,
        enrolledAt: toIsoOrNull(userData.mfaEnrolledAt),
      },
      passkeys,
      totalFactors: (factors.totp ? 1 : 0) + passkeys.length,
      mfaVerified: session?.mfaVerified === true,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/factors');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
