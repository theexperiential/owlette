'use client';

import { useCallback, useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/webauthn.server';

/**
 * The single owner of the account's second-factor inventory on the client.
 *
 * Modelled on {@link usePasskeys} — fetch-based, never a direct Firestore read.
 * It cannot be anything else: `users/{uid}.mfaFactors` / `mfaEnrolledAt` are not
 * readable from the browser (`firestore.rules` keeps the MFA fields
 * Admin-SDK-only), so `/api/mfa/factors` is the only way this state reaches a
 * component. A component that reaches for `firebase/firestore` to answer "does
 * this account have TOTP?" is reaching for a document it cannot read.
 *
 * Scope note — why the passkey ceremonies are NOT here: `usePasskeys` already
 * owns register / delete / rename, and `PasskeyManager` already renders them.
 * This hook deliberately duplicates none of that; it reports the inventory and
 * owns the two mutations that had no client at all before (removing the TOTP
 * factor, and the in-place step-up that unblocks enrollment).
 */

export interface MfaTotpFactor {
  enrolled: boolean;
  /** ISO-8601, or null on an account enrolled before the field existed. */
  enrolledAt: string | null;
}

export interface MfaFactorsSnapshot {
  totp: MfaTotpFactor;
  passkeys: PasskeyInfo[];
  /** TOTP (0 or 1) + registered passkeys. Zero means mandatory setup. */
  totalFactors: number;
  /**
   * Whether this session has already cleared an MFA challenge. Mirrors what
   * `checkMfaEnrollmentGate` will decide, so the UI can offer a step-up BEFORE
   * sending the user somewhere that would 403 them.
   */
  mfaVerified: boolean;
}

/** What the UI renders before the first response lands. */
const EMPTY_SNAPSHOT: MfaFactorsSnapshot = {
  totp: { enrolled: false, enrolledAt: null },
  passkeys: [],
  totalFactors: 0,
  mfaVerified: false,
};

/** Pull the server's own sentence out of a failed response, else a fallback. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

export function useMfaFactors(userId: string | undefined) {
  const [factors, setFactors] = useState<MfaFactorsSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setFactors(EMPTY_SNAPSHOT);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      // No userId in the request: the route derives it from the session.
      const res = await fetch('/api/mfa/factors');
      if (!res.ok) {
        throw new Error(await errorMessage(res, 'failed to load second factors'));
      }
      const data = (await res.json()) as Partial<MfaFactorsSnapshot>;
      setFactors({
        totp: data.totp ?? EMPTY_SNAPSHOT.totp,
        passkeys: data.passkeys ?? [],
        totalFactors: data.totalFactors ?? 0,
        mfaVerified: data.mfaVerified === true,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load second factors');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Remove the TOTP factor.
   *
   * `/api/mfa/disable` demands live proof of possession every time — a current
   * TOTP code or an unused backup code — so this takes the code rather than
   * relying on the warm session. Removing the last factor is allowed and
   * re-arms `requiresMfaSetup`; the route owns that, and this client never
   * second-guesses it.
   */
  const removeTotp = useCallback(
    async (code: string, isBackupCode = false) => {
      const res = await fetch('/api/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, isBackupCode }),
      });

      if (!res.ok) {
        throw new Error(await errorMessage(res, 'failed to remove authenticator app'));
      }

      await refresh();
    },
    [refresh],
  );

  /**
   * Clear the MFA challenge for THIS session with a passkey, without leaving
   * the page.
   *
   * The enrollment gate refuses to add a second factor from a session that has
   * not proved the first one. Sending the user to /verify-2fa works but costs
   * them the dialog they were in, so an account that already holds a passkey
   * gets the same ceremony inline. This is the `/api/passkeys/step-up/*` pair —
   * NOT `/authenticate/*`, which is the pre-login route that mints a session.
   */
  const stepUpWithPasskey = useCallback(async () => {
    const optionsRes = await fetch('/api/passkeys/step-up/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!optionsRes.ok) {
      throw new Error(await errorMessage(optionsRes, 'failed to start passkey verification'));
    }
    const { options, challengeId } = await optionsRes.json();

    const credential = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch('/api/passkeys/step-up/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, challengeId }),
    });
    if (!verifyRes.ok) {
      throw new Error(await errorMessage(verifyRes, 'passkey verification failed'));
    }

    // The session cookie was just re-minted with `mfaVerified: true`; refresh so
    // the panel drops the "verify first" callout without a reload.
    await refresh();
  }, [refresh]);

  return {
    factors,
    loading,
    error,
    refresh,
    removeTotp,
    stepUpWithPasskey,
  };
}
