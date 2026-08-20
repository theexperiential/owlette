'use client';

import { useState, useEffect, useCallback } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/webauthn.server';

export { browserSupportsWebAuthn };

/**
 * The slug `checkMfaEnrollmentGate` returns with its 403 when the account
 * already holds a second factor and this session has not proved one.
 *
 * Duplicated as a literal rather than imported from
 * `lib/mfaEnrollmentGate.server.ts`: that module pulls in `firebase-admin` and
 * `next/server`, neither of which belongs in a client bundle. Keep the two in
 * sync — the server constant is `MFA_CHALLENGE_REQUIRED` in the same file.
 */
export const MFA_CHALLENGE_REQUIRED = 'mfa_challenge_required';

/**
 * An error carrying the server's machine-readable `code` alongside its message.
 *
 * The gate's 403 body is `{ error: '<friendly sentence>', code: '<slug>' }`. A
 * bare `new Error(data.error)` renders fine but strands the caller: it cannot
 * tell "you must verify your existing factor first" (recoverable, offer a
 * step-up) from "that passkey is already registered" (not recoverable), so
 * every gated attempt dead-ends in a toast. The sentence is still the message —
 * we never surface the slug to a human.
 */
export class PasskeyApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PasskeyApiError';
    this.code = code;
  }
}

/** True when `err` is the enrollment gate asking for a challenge to be cleared. */
export function isMfaChallengeRequired(err: unknown): boolean {
  return err instanceof PasskeyApiError && err.code === MFA_CHALLENGE_REQUIRED;
}

/**
 * Turn a failed response into a `PasskeyApiError` carrying both legs of the
 * body. `fallback` covers a response with no JSON at all (a proxy 502, say).
 */
async function passkeyApiError(res: Response, fallback: string): Promise<PasskeyApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return new PasskeyApiError(body.error || fallback, body.code);
}

export function usePasskeys(userId: string | undefined) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshPasskeys = useCallback(async () => {
    if (!userId) {
      setPasskeys([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(`/api/passkeys/list?userId=${encodeURIComponent(userId)}`);
      if (!res.ok) {
        throw new Error('Failed to fetch passkeys');
      }
      const data = await res.json();
      setPasskeys(data.passkeys || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch passkeys');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refreshPasskeys();
  }, [refreshPasskeys]);

  const registerPasskey = useCallback(async (friendlyName?: string) => {
    if (!userId) throw new Error('Not authenticated');

    // Step 1: Get registration options from server
    const optionsRes = await fetch('/api/passkeys/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    if (!optionsRes.ok) {
      // Gated: an account with an existing factor must clear a challenge before
      // it can add another. The caller keys off `code` to offer a step-up.
      throw await passkeyApiError(optionsRes, 'Failed to get registration options');
    }

    const options = await optionsRes.json();

    // Step 2: Start WebAuthn registration (browser prompt)
    const credential = await startRegistration({ optionsJSON: options });

    // Step 3: Verify with server
    const verifyRes = await fetch('/api/passkeys/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        credential,
        friendlyName: friendlyName || 'Passkey',
      }),
    });

    if (!verifyRes.ok) {
      throw await passkeyApiError(verifyRes, 'Failed to verify registration');
    }

    // Refresh list
    await refreshPasskeys();
  }, [userId, refreshPasskeys]);

  const deletePasskey = useCallback(async (credentialId: string) => {
    if (!userId) throw new Error('Not authenticated');

    const res = await fetch(
      `/api/passkeys/${encodeURIComponent(credentialId)}?userId=${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );

    if (!res.ok) {
      throw await passkeyApiError(res, 'Failed to delete passkey');
    }

    // Refresh list
    await refreshPasskeys();
  }, [userId, refreshPasskeys]);

  const renamePasskey = useCallback(async (credentialId: string, name: string) => {
    if (!userId) throw new Error('Not authenticated');

    const res = await fetch(`/api/passkeys/${encodeURIComponent(credentialId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, friendlyName: name }),
    });

    if (!res.ok) {
      throw await passkeyApiError(res, 'Failed to rename passkey');
    }

    // Optimistic update
    setPasskeys((prev) =>
      prev.map((p) =>
        p.credentialId === credentialId ? { ...p, friendlyName: name } : p
      )
    );
  }, [userId]);

  return {
    passkeys,
    loading,
    error,
    supported: browserSupportsWebAuthn(),
    registerPasskey,
    deletePasskey,
    renamePasskey,
    refreshPasskeys,
  };
}
