'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Shared "enter code" device-code authorization.
 *
 * Two surfaces let an operator type the installer's 3-word pairing phrase to
 * authorize a machine: the dashboard's AddMachineButton modal and the
 * zero-machine "getting started" card. This hook is the single implementation
 * of the authorize call so the two never drift.
 *
 * `POST /api/agent/auth/device-code/authorize` only requires a session + site
 * access (no precondition that the site already have a machine), so this works
 * on a brand-new, empty site — which is exactly when the getting-started card
 * needs it.
 */
export function useDeviceCodeAuthorize(siteId: string) {
  const [phrase, setPhrase] = useState('');
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [success, setSuccess] = useState(false);

  const authorize = useCallback(async () => {
    const trimmed = phrase.trim();
    if (!trimmed || !siteId) return;

    setIsAuthorizing(true);
    try {
      const response = await fetch('/api/agent/auth/device-code/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairPhrase: trimmed.toLowerCase(),
          siteId,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Authorization failed');
      }

      setSuccess(true);
      toast.success('Machine authorized! It will appear on your dashboard shortly.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to authorize machine');
    } finally {
      setIsAuthorizing(false);
    }
  }, [phrase, siteId]);

  const reset = useCallback(() => {
    setPhrase('');
    setIsAuthorizing(false);
    setSuccess(false);
  }, []);

  return { phrase, setPhrase, authorize, isAuthorizing, success, reset };
}
