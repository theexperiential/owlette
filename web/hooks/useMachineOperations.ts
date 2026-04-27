'use client';

import { useState } from 'react';
import { db } from '@/lib/firebase';

export function useMachineOperations(siteId: string) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Removes a machine from a site by deleting all its data from Firestore.
   * This performs a hard delete of:
   * - Main machine document (sites/{siteId}/machines/{machineId})
   * - Machine config (config/{siteId}/machines/{machineId})
   * - All command subcollections (commands/pending/*, commands/completed/*)
   *
   * @param machineId - The ID of the machine to remove
   * @returns Promise that resolves when removal is complete
   * @throws Error if removal fails
   */
  const removeMachineFromSite = async (machineId: string): Promise<void> => {
    if (!db || !siteId) {
      throw new Error('Firebase not configured or no site selected');
    }

    if (!machineId) {
      throw new Error('Machine ID is required');
    }

    setRemoving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to remove machine'));
      }

      console.log(`Successfully removed machine ${machineId} from site ${siteId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error removing machine:', err);
      setError(message || 'Failed to remove machine');
      throw err;
    } finally {
      setRemoving(false);
    }
  };

  return {
    removeMachineFromSite,
    removing,
    error,
  };
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
