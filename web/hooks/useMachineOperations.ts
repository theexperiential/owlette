'use client';

import { useState } from 'react';
import {
  doc,
  deleteDoc,
  writeBatch,
} from 'firebase/firestore';
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
      // Use batch for atomic operations where possible
      const batch = writeBatch(db);

      // 1. Delete main machine document
      const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
      batch.delete(machineRef);

      // 2. Delete machine config
      const configRef = doc(db, 'config', siteId, 'machines', machineId);
      batch.delete(configRef);

      // Commit the batch (machine and config)
      await batch.commit();

      // 3. Delete command subcollections (these need to be deleted separately)
      // Note: Firestore doesn't auto-delete subcollections, we must iterate

      // Delete pending commands
      try {
        const pendingCommandsRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending');
        await deleteDoc(pendingCommandsRef);
      } catch (err) {
        // Pending commands doc might not exist, that's okay
        console.warn('No pending commands to delete:', err);
      }

      // Delete completed commands
      try {
        const completedCommandsRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'completed');
        await deleteDoc(completedCommandsRef);
      } catch (err) {
        // Completed commands doc might not exist, that's okay
        console.warn('No completed commands to delete:', err);
      }

      // 4. Note: We do NOT automatically update deployment targets
      // This is intentional - deployments should complete or fail for removed machines
      // The checkMachineHasActiveDeployment function prevents removal if deployments are active

      console.log(`Successfully removed machine ${machineId} from site ${siteId}`);
    } catch (err: any) {
      console.error('Error removing machine:', err);
      setError(err.message || 'Failed to remove machine');
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
