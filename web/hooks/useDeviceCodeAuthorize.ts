'use client';

import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';

/**
 * Shared "enter code" device-code authorization — one implementation for both
 * the AddMachineButton modal and the zero-machine getting-started card, so the
 * two cannot drift.
 *
 * `POST /api/agent/auth/device-code/authorize` needs only a session + site
 * access, not an existing machine, so it works on a brand-new empty site.
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
