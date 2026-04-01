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
  /** Machines that have been "Updating..." for > 15 min without reporting back */
  staleMachines: Set<string>;
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
  // ANTI-FRAGILE: Track when each machine started updating for timeout detection
  const [updateStartTimes, setUpdateStartTimes] = useState<Map<string, number>>(new Map());
  // Machines that have been updating for > 15 minutes without reporting back
  const [staleMachines, setStaleMachines] = useState<Set<string>>(new Set());

  // Cancel/clear updating status for a machine
  const cancelUpdate = useCallback((machineId: string) => {
    setUpdatingMachines(prev => {
      const newSet = new Set(prev);
      newSet.delete(machineId);
      return newSet;
    });
    setUpdateStartTimes(prev => {
      const newMap = new Map(prev);
      newMap.delete(machineId);
      return newMap;
    });
    setStaleMachines(prev => {
      const newSet = new Set(prev);
      newSet.delete(machineId);
      return newSet;
    });
  }, []);

  // ANTI-FRAGILE: Detect stale updates (machines that have been "Updating..." for > 15 min)
  // This prevents the UI from showing "Updating..." forever if the agent crashes mid-update
  useEffect(() => {
    if (updatingMachines.size === 0) return;

    const UPDATE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const newStaleMachines = new Set<string>();

      updatingMachines.forEach(machineId => {
        const startTime = updateStartTimes.get(machineId);
        if (startTime && (now - startTime) > UPDATE_TIMEOUT_MS) {
          newStaleMachines.add(machineId);
        }
      });

      if (newStaleMachines.size > 0) {
        setStaleMachines(newStaleMachines);
      }
    }, 30_000); // Check every 30 seconds

    return () => clearInterval(checkInterval);
  }, [updatingMachines, updateStartTimes]);

  // Auto-clear "Updating..." status when machine successfully updates
  useEffect(() => {
    if (updatingMachines.size === 0) return;

    const clearedIds: string[] = [];

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
          clearedIds.push(machineId);
          changed = true;
          console.log(`Auto-cleared update status for ${machineId} (now at v${machine.agent_version})`);
        }
      });

      return changed ? newSet : prev;
    });

    // Clean up associated state for cleared machines
    if (clearedIds.length > 0) {
      setUpdateStartTimes(prev => {
        const newMap = new Map(prev);
        clearedIds.forEach(id => newMap.delete(id));
        return newMap;
      });
      setStaleMachines(prev => {
        const newSet = new Set(prev);
        clearedIds.forEach(id => newSet.delete(id));
        return newSet;
      });
    }
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
   *
   * ANTI-FRAGILE: Uses Promise.allSettled so one machine's failure doesn't cancel others.
   * Tracks update start time per machine for timeout detection.
   */
  const updateMachines = useCallback(async (siteId: string, machineIds: string[]) => {
    setUpdateError(null);

    try {
      // Get latest version metadata
      const versionData = await getLatestOwletteVersion();

      if (!versionData || !versionData.downloadUrl) {
        throw new Error('No Owlette installer uploaded yet. Please upload an installer via Admin → Installers first.');
      }

      // ANTI-FRAGILE: Validate checksum exists before sending to any machine
      // Agent now rejects updates without checksum, so fail fast on web side
      if (!versionData.sha256Checksum) {
        throw new Error('Installer checksum not available. Please re-upload the installer via Admin → Installers.');
      }

      // Mark machines as updating with timestamp for timeout tracking
      const now = Date.now();
      setUpdatingMachines(prev => {
        const newSet = new Set(prev);
        machineIds.forEach(id => newSet.add(id));
        return newSet;
      });
      setUpdateStartTimes(prev => {
        const newMap = new Map(prev);
        machineIds.forEach(id => newMap.set(id, now));
        return newMap;
      });

      // ANTI-FRAGILE: Use Promise.allSettled so one machine's Firestore write failure
      // doesn't cancel commands already sent to other machines
      const results = await Promise.allSettled(
        machineIds.map(machineId =>
          sendOwletteUpdateCommand(
            siteId,
            machineId,
            versionData.downloadUrl,
            undefined,
            versionData.version,
            versionData.sha256Checksum
          )
        )
      );

      // Collect failures and remove only failed machines from updating state
      const failedMachineIds: string[] = [];
      const errors: string[] = [];

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const machineId = machineIds[index];
          failedMachineIds.push(machineId);
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          errors.push(`${machineId}: ${errMsg}`);
          console.error(`Failed to send update to ${machineId}:`, result.reason);
        }
      });

      const successCount = machineIds.length - failedMachineIds.length;

      if (failedMachineIds.length > 0) {
        // Remove only the failed machines from updating state
        setUpdatingMachines(prev => {
          const newSet = new Set(prev);
          failedMachineIds.forEach(id => newSet.delete(id));
          return newSet;
        });
        setUpdateStartTimes(prev => {
          const newMap = new Map(prev);
          failedMachineIds.forEach(id => newMap.delete(id));
          return newMap;
        });

        const errorMessage = `${successCount}/${machineIds.length} updates sent. Failed: ${errors.join('; ')}`;
        if (successCount === 0) {
          setUpdateError(errorMessage);
          throw new Error(errorMessage);
        } else {
          // Partial success - report error but don't throw (some commands went through)
          setUpdateError(errorMessage);
        }
      }

      console.log(`Successfully sent update commands to ${successCount}/${machineIds.length} machine(s)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update machines';
      if (!errorMessage.includes('updates sent')) {
        // Only set error if we haven't already set a partial-success error
        setUpdateError(errorMessage);
      }

      // On total failure (before any commands sent), remove all from updating state
      setUpdatingMachines(prev => {
        const newSet = new Set(prev);
        machineIds.forEach(id => newSet.delete(id));
        return newSet;
      });
      setUpdateStartTimes(prev => {
        const newMap = new Map(prev);
        machineIds.forEach(id => newMap.delete(id));
        return newMap;
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
    cancelUpdate,
    staleMachines,
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
