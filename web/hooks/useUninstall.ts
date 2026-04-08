'use client';

import { useState } from 'react';
import { collection, doc, setDoc, getDoc, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface Software {
  name: string;
  version: string;
  publisher: string;
  install_location: string;
  uninstall_command: string;
  installer_type: string;
  registry_key: string;
}

/**
 * Hook for managing software uninstallation
 */
export function useUninstall() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch installed software from a specific machine
   */
  const fetchMachineSoftware = async (siteId: string, machineId: string): Promise<Software[]> => {
    if (!db || !siteId || !machineId) {
      throw new Error('Invalid parameters');
    }

    try {
      const softwareRef = collection(db, 'sites', siteId, 'machines', machineId, 'installed_software');
      const snapshot = await getDocs(softwareRef);

      const software: Software[] = [];
      snapshot.forEach((doc) => {
        software.push(doc.data() as Software);
      });

      return software.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      console.error('Failed to fetch software:', err);
      throw new Error(err.message || 'Failed to fetch installed software');
    }
  };

  /**
   * Fetch software from multiple machines and return unique list
   */
  const fetchSoftwareFromMachines = async (siteId: string, machineIds: string[]): Promise<Software[]> => {
    if (!db || !siteId || machineIds.length === 0) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      const softwareMap = new Map<string, Software>();

      for (const machineId of machineIds) {
        try {
          const softwareList = await fetchMachineSoftware(siteId, machineId);
          softwareList.forEach((software) => {
            const key = `${software.name}_${software.version}`;
            if (!softwareMap.has(key)) {
              softwareMap.set(key, software);
            }
          });
        } catch (err) {
          console.error(`Failed to fetch software from ${machineId}:`, err);
        }
      }

      const uniqueSoftware = Array.from(softwareMap.values());
      return uniqueSoftware.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to fetch software';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Create uninstall commands for selected machines
   */
  const createUninstall = async (
    siteId: string,
    softwareName: string,
    machineIds: string[],
    deploymentId?: string
  ): Promise<void> => {
    if (!db || !siteId || !softwareName || machineIds.length === 0) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[useUninstall] Creating uninstall:', { siteId, softwareName, machineIds, deploymentId });

      // First, fetch software details from one of the machines to get uninstall command
      let softwareDetails: Software | null = null;

      console.log('[useUninstall] Fetching software details from machines...');
      for (const machineId of machineIds) {
        const softwareList = await fetchMachineSoftware(siteId, machineId);
        const found = softwareList.find(s => s.name === softwareName);
        if (found) {
          softwareDetails = found;
          console.log('[useUninstall] Found software details:', softwareDetails);
          break;
        }
      }

      if (!softwareDetails) {
        throw new Error(`Software "${softwareName}" not found on selected machines`);
      }

      // Create uninstall command for each machine
      const commandId = `uninstall-${Date.now()}`;

      console.log('[useUninstall] Creating commands for machines with ID:', commandId);

      for (const machineId of machineIds) {
        console.log(`[useUninstall] Creating command for machine: ${machineId}`);

        // Send uninstall_software command to each machine
        const commandRef = doc(
          db,
          'sites',
          siteId,
          'machines',
          machineId,
          'commands',
          'pending'
        );

        // Get existing commands
        const commandDoc = await getDoc(commandRef);
        const existingCommands = commandDoc.exists() ? commandDoc.data() : {};

        // Add new uninstall command
        const newCommand: any = {
          type: 'uninstall_software',
          software_name: softwareDetails.name,
          uninstall_command: softwareDetails.uninstall_command,
          installer_type: softwareDetails.installer_type,
          verify_paths: softwareDetails.install_location ? [softwareDetails.install_location] : [],
          timestamp: serverTimestamp(),
        };

        // Only include deployment_id if provided (when uninstalling from deployment view)
        if (deploymentId) {
          newCommand.deployment_id = deploymentId;
        }

        console.log(`[useUninstall] Writing command to Firestore:`, newCommand);

        // Merge with existing commands
        await setDoc(commandRef, {
          ...existingCommands,
          [commandId]: newCommand,
        });

        console.log(`[useUninstall] Command written successfully for ${machineId}`);
      }

      console.log(`[useUninstall] All uninstall commands created for ${machineIds.length} machines`);
    } catch (err: any) {
      console.error('[useUninstall] Error:', err);
      const errorMsg = err.message || 'Failed to create uninstall commands';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Cancel an active uninstallation on a machine
   */
  const cancelUninstall = async (
    siteId: string,
    machineId: string,
    softwareName: string
  ): Promise<void> => {
    if (!db || !siteId || !machineId || !softwareName) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      const commandRef = doc(
        db,
        'sites',
        siteId,
        'machines',
        machineId,
        'commands',
        'pending'
      );

      // Get existing commands
      const commandDoc = await getDoc(commandRef);
      const existingCommands = commandDoc.exists() ? commandDoc.data() : {};

      // Add cancel command
      const cancelCommandId = `cancel-uninstall-${Date.now()}`;
      await setDoc(commandRef, {
        ...existingCommands,
        [cancelCommandId]: {
          type: 'cancel_uninstall',
          software_name: softwareName,
          timestamp: serverTimestamp(),
        },
      });

      console.log(`Cancel uninstall command sent for ${softwareName} on ${machineId}`);
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to cancel uninstall';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    error,
    fetchMachineSoftware,
    fetchSoftwareFromMachines,
    createUninstall,
    cancelUninstall,
  };
}
