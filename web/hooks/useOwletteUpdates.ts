/**
 * useOwletteUpdates Hook
 *
 * Combines machine data with latest installer version to detect which machines need updates.
 * Provides update status, outdated machines list, and version comparison.
 *
 * Pattern: Combines existing hooks for specific functionality (DRY principle)
 */

'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import { Machine } from './useFirestore';
import { useInstallerVersion } from './useInstallerVersion';
import { isOutdated, compareVersions } from '@/lib/versionUtils';
import { getLatestOwletteVersion, sendOwletteUpdateCommand } from '@/lib/firebase';

export interface MachineUpdateStatus {
  machine: Machine;
  needsUpdate: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface UseOwletteUpdatesReturn {
  outdatedMachines: Machine[];
  machineUpdateStatuses: MachineUpdateStatus[];
  latestVersion: string | null;
  totalMachinesNeedingUpdate: number;
  isLoading: boolean;
  error: string | null;
  getMachineUpdateStatus: (machine: Machine) => MachineUpdateStatus;
  // Update execution
  updateMachines: (siteId: string, machineIds: string[]) => Promise<void>;
  updatingMachines: Set<string>;
  updateError: string | null;
  cancelUpdate: (machineId: string) => void;
}

/**
 * Hook to detect which machines need Owlette agent updates
 *
 * @param machines - Array of machines from useFirestore
 * @returns Update detection interface
 *
 * @example
 * const { machines } = useMachines(siteId);
 * const {
 *   outdatedMachines,
 *   latestVersion,
 *   totalMachinesNeedingUpdate
 * } = useOwletteUpdates(machines);
 *
 * // Show update banner if machines need updates
 * {totalMachinesNeedingUpdate > 0 && (
 *   <UpdateBanner count={totalMachinesNeedingUpdate} version={latestVersion} />
 * )}
 */
export function useOwletteUpdates(machines: Machine[]): UseOwletteUpdatesReturn {
  // Get latest installer version
  const {
    version: latestVersion,
    isLoading: versionLoading,
    error: versionError
  } = useInstallerVersion();

  // Update execution state
  const [updatingMachines, setUpdatingMachines] = useState<Set<string>>(new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Cancel/clear updating status for a machine
  const cancelUpdate = useCallback((machineId: string) => {
    setUpdatingMachines(prev => {
      const newSet = new Set(prev);
      newSet.delete(machineId);
      return newSet;
    });
  }, []);

  // Auto-clear "Updating..." status when machine successfully updates
  useEffect(() => {
    if (updatingMachines.size === 0) return;

    setUpdatingMachines(prev => {
      const newSet = new Set(prev);
      let changed = false;

      // Check each updating machine
      prev.forEach(machineId => {
        const machine = machines.find(m => m.machineId === machineId);
        if (!machine) return;

        // Clear if machine is now up-to-date
        const isUpToDate = !isOutdated(machine.agent_version, latestVersion);
        if (isUpToDate) {
          newSet.delete(machineId);
          changed = true;
          console.log(`Auto-cleared update status for ${machineId} (now at v${machine.agent_version})`);
        }
      });

      return changed ? newSet : prev;
    });
  }, [machines, latestVersion, updatingMachines]);

  // Calculate machine update statuses
  const machineUpdateStatuses = useMemo<MachineUpdateStatus[]>(() => {
    if (!machines || machines.length === 0) {
      return [];
    }

    return machines.map(machine => {
      const currentVersion = machine.agent_version || null;
      const normalizedLatestVersion = latestVersion || null;
      const needsUpdate = isOutdated(currentVersion, normalizedLatestVersion);

      return {
        machine,
        needsUpdate,
        currentVersion,
        latestVersion: normalizedLatestVersion,
        updateAvailable: needsUpdate && !!normalizedLatestVersion
      };
    });
  }, [machines, latestVersion]);

  // Filter to only outdated machines
  const outdatedMachines = useMemo(() => {
    return machineUpdateStatuses
      .filter(status => status.needsUpdate)
      .map(status => status.machine);
  }, [machineUpdateStatuses]);

  // Count machines needing updates
  const totalMachinesNeedingUpdate = outdatedMachines.length;

  /**
   * Get update status for a specific machine
   */
  const getMachineUpdateStatus = (machine: Machine): MachineUpdateStatus => {
    const existingStatus = machineUpdateStatuses.find(
      status => status.machine.machineId === machine.machineId
    );

    if (existingStatus) {
      return existingStatus;
    }

    // If not found, calculate on the fly
    const currentVersion = machine.agent_version || null;
    const normalizedLatestVersion = latestVersion || null;
    const needsUpdate = isOutdated(currentVersion, normalizedLatestVersion);

    return {
      machine,
      needsUpdate,
      currentVersion,
      latestVersion: normalizedLatestVersion,
      updateAvailable: needsUpdate && !!normalizedLatestVersion
    };
  };

  /**
   * Execute Owlette update on specified machines
   */
  const updateMachines = useCallback(async (siteId: string, machineIds: string[]) => {
    setUpdateError(null);

    try {
      // Get latest version metadata
      const versionData = await getLatestOwletteVersion();

      if (!versionData || !versionData.downloadUrl) {
        throw new Error('No Owlette installer uploaded yet. Please upload an installer via Admin → Installers first.');
      }

      // Mark machines as updating
      setUpdatingMachines(prev => {
        const newSet = new Set(prev);
        machineIds.forEach(id => newSet.add(id));
        return newSet;
      });

      // Send update commands to all machines (with version + checksum for agent verification)
      const updatePromises = machineIds.map(machineId =>
        sendOwletteUpdateCommand(
          siteId,
          machineId,
          versionData.downloadUrl,
          undefined,
          versionData.version,
          versionData.sha256Checksum
        )
          .catch(error => {
            console.error(`Failed to send update to ${machineId}:`, error);
            throw error;
          })
      );

      await Promise.all(updatePromises);

      console.log(`Successfully sent update commands to ${machineIds.length} machine(s)`);

      // Keep machines in "updating" state for a bit
      // (They'll be removed when the component unmounts or machines reconnect with new version)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update machines';
      setUpdateError(errorMessage);

      // Remove machines from updating state on error
      setUpdatingMachines(prev => {
        const newSet = new Set(prev);
        machineIds.forEach(id => newSet.delete(id));
        return newSet;
      });

      throw error;
    }
  }, []);

  return {
    outdatedMachines,
    machineUpdateStatuses,
    latestVersion: latestVersion || null,
    totalMachinesNeedingUpdate,
    isLoading: versionLoading,
    error: versionError,
    getMachineUpdateStatus,
    updateMachines,
    updatingMachines,
    updateError,
    cancelUpdate
  };
}

/**
 * Helper hook to get just the count of machines needing updates
 * (lighter weight if you only need the count)
 */
export function useUpdateCount(machines: Machine[]): {
  count: number;
  isLoading: boolean;
} {
  const { totalMachinesNeedingUpdate, isLoading } = useOwletteUpdates(machines);

  return {
    count: totalMachinesNeedingUpdate,
    isLoading
  };
}
