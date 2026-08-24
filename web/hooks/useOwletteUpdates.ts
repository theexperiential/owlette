/**
 * Combines machine data with the latest installer version to detect which
 * machines need an agent update, and drives the update commands.
 */

'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import { Machine } from './useFirestore';
import { useInstallerVersion } from './useInstallerVersion';
import { isOutdated } from '@/lib/versionUtils';
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
  updateMachines: (siteId: string, machineIds: string[]) => Promise<void>;
  updatingMachines: Set<string>;
  updateError: string | null;
  cancelUpdate: (machineId: string) => void;
  /** Machines that have been "Updating..." for > 15 min without reporting back */
  staleMachines: Set<string>;
}

export function useOwletteUpdates(machines: Machine[]): UseOwletteUpdatesReturn {
  const {
    version: latestVersion,
    isLoading: versionLoading,
    error: versionError
  } = useInstallerVersion();

  const [updatingMachines, setUpdatingMachines] = useState<Set<string>>(new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Start times drive the stale-update timeout below.
  const [updateStartTimes, setUpdateStartTimes] = useState<Map<string, number>>(new Map());
  const [staleMachines, setStaleMachines] = useState<Set<string>>(new Set());

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

  // Without this the UI shows "Updating..." forever if the agent crashes mid-update.
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
    }, 30_000);

    return () => clearInterval(checkInterval);
  }, [updatingMachines, updateStartTimes]);

  useEffect(() => {
    if (updatingMachines.size === 0) return;

    const clearedIds: string[] = [];

    setUpdatingMachines(prev => {
      const newSet = new Set(prev);
      let changed = false;

      prev.forEach(machineId => {
        const machine = machines.find(m => m.machineId === machineId);
        if (!machine) return;

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

  const outdatedMachines = useMemo(() => {
    return machineUpdateStatuses
      .filter(status => status.needsUpdate)
      .map(status => status.machine);
  }, [machineUpdateStatuses]);

  const totalMachinesNeedingUpdate = outdatedMachines.length;

  const getMachineUpdateStatus = (machine: Machine): MachineUpdateStatus => {
    const existingStatus = machineUpdateStatuses.find(
      status => status.machine.machineId === machine.machineId
    );

    if (existingStatus) {
      return existingStatus;
    }

    // Not in the memo (machine outside `machines`) — compute on the fly.
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
   * Send the update command to each machine. `Promise.allSettled` so one
   * machine's failure doesn't cancel the commands already sent to the others.
   */
  const updateMachines = useCallback(async (siteId: string, machineIds: string[]) => {
    setUpdateError(null);

    try {
      const versionData = await getLatestOwletteVersion();

      if (!versionData || !versionData.downloadUrl) {
        throw new Error('No Owlette installer uploaded yet. Please upload an installer via Admin → Installers first.');
      }

      // The agent rejects updates without a checksum — fail fast here instead.
      if (!versionData.sha256Checksum) {
        throw new Error('Installer checksum not available. Please re-upload the installer via Admin → Installers.');
      }

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
          // Partial success: report but don't throw — some commands went through.
          setUpdateError(errorMessage);
        }
      }

      console.log(`Successfully sent update commands to ${successCount}/${machineIds.length} machine(s)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update machines';
      if (!errorMessage.includes('updates sent')) {
        setUpdateError(errorMessage);
      }

      // Total failure before any command was sent — clear every machine.
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
