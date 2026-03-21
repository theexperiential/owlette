'use client';

import { useState, useEffect, useCallback } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/webauthn.server';

export { browserSupportsWebAuthn };

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
      const data = await optionsRes.json();
      throw new Error(data.error || 'Failed to get registration options');
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
      const data = await verifyRes.json();
      throw new Error(data.error || 'Failed to verify registration');
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
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete passkey');
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
      const data = await res.json();
      throw new Error(data.error || 'Failed to rename passkey');
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
