'use client';

import { useEffect, useState, useRef } from 'react';
import { collection, onSnapshot, doc, setDoc, deleteDoc, updateDoc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { logger } from '@/lib/logger';

export type LaunchMode = 'off' | 'always' | 'scheduled';

export interface TimeRange {
  start: string; // "HH:MM"
  stop: string;  // "HH:MM"
}

export interface ScheduleBlock {
  name?: string;       // Optional custom name (e.g. 'Morning shift')
  colorIndex?: number; // Stable color assignment (persists when blocks are deleted)
  days: string[];      // e.g. ['mon', 'tue', 'wed', 'thu', 'fri']
  ranges: TimeRange[];
}

export interface Process {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  autolaunch: boolean;
  launch_mode?: LaunchMode;
  schedules?: ScheduleBlock[] | null;
  schedulePresetId?: string | null;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  responsive: boolean;
  last_updated: number;
  index: number; // Order from config file
  // For optimistic UI updates
  _optimisticAutolaunch?: boolean;
  _optimisticLaunchMode?: LaunchMode;
  _optimisticSchedules?: ScheduleBlock[] | null;
  _optimisticPresetId?: string | null;
}

export interface Machine {
  machineId: string;
  lastHeartbeat: number;
  online: boolean;
  agent_version?: string;  // Agent version for update detection (e.g., "2.0.0")
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootPending?: {
    active: boolean;
    processName: string | null;
    reason: string | null;
    timestamp: number | null;
  };
  rebootSchedule?: {
    enabled: boolean;
    schedules: ScheduleBlock[];
  };
  lastScreenshot?: {
    url: string;       // Firebase Storage public URL
    timestamp: number;
    sizeKB: number;
  };
  liveView?: {
    active: boolean;
    interval?: number;
    startedAt?: number;
    expiresAt?: number;
  };
  metrics?: {
    cpu: { name?: string; percent: number; unit: string; temperature?: number };
    memory: { percent: number; total_gb: number; used_gb: number; unit: string };
    disk: { percent: number; total_gb: number; used_gb: number; unit: string };
    gpu?: { name: string; usage_percent: number; vram_total_gb: number; vram_used_gb: number; unit: string; temperature?: number };
    network?: {
      interfaces?: Record<string, {
        tx_bps: number;
        rx_bps: number;
        tx_util: number;
        rx_util: number;
        link_speed: number;
      }>;
      gateway_ip?: string | null;
      latency_ms?: number | null;
      packet_loss_pct?: number | null;
    };
    processes?: Record<string, string>;
  };
  processes?: Process[];
}

export interface Site {
  id: string;
  name: string;
  createdAt: number;
  timezone?: string;  // IANA timezone, e.g., "America/New_York"
  timeFormat?: '12h' | '24h';  // Time display format (default: '12h')
}

export function useSites(userId?: string, userSites?: string[], isAdmin?: boolean) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db) {
      setLoading(false);
      setError('Firebase not configured');
      return;
    }

    // If user data not loaded yet, wait
    if (userSites === undefined || isAdmin === undefined || userId === undefined) {
      setLoading(true);
      return;
    }


    try {
      // ADMINS: Query all sites
      if (isAdmin) {
        const sitesRef = collection(db, 'sites');
        const unsubscribe = onSnapshot(
          sitesRef,
          (snapshot) => {
            const siteData: Site[] = [];
            snapshot.forEach((doc) => {
              const data = doc.data();
              siteData.push({
                id: doc.id,
                name: data.name || doc.id,
                createdAt: data.createdAt || Date.now(),
                timezone: data.timezone,
              });
            });
            siteData.sort((a, b) => a.name.localeCompare(b.name));
            console.log('👑 Admin - loaded all sites:', siteData.map(s => s.id));
            setSites(siteData);
            setLoading(false);
          },
          (err) => {
            console.error('Error fetching sites:', err);
            setError(err.message);
            setLoading(false);
          }
        );
        return () => unsubscribe();
      }

      // NON-ADMINS: Fetch each assigned site individually by ID.
      // Collection queries (e.g. where('owner', '==', uid)) fail because
      // Firestore rules use get() calls that can't be evaluated for queries.
      const unsubscribes: (() => void)[] = [];
      const siteDataMap = new Map<string, Site>();

      const updateStateFromMap = () => {
        const siteArray = Array.from(siteDataMap.values());
        siteArray.sort((a, b) => a.name.localeCompare(b.name));
        setSites(siteArray);
        setLoading(false);
      };

      if (userSites.length === 0) {
        setLoading(false);
      }

      userSites.forEach((siteId) => {
        const siteDocRef = doc(db!, 'sites', siteId);
        const unsubscribe = onSnapshot(
          siteDocRef,
          (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();
              siteDataMap.set(siteId, {
                id: siteId,
                name: data.name || siteId,
                createdAt: data.createdAt || Date.now(),
                timezone: data.timezone,
              });
            } else {
              siteDataMap.delete(siteId);
              console.warn(`Site "${siteId}" not found in Firestore`);
            }

            updateStateFromMap();
          },
          (err) => {
            console.error(`Error fetching site ${siteId}:`, err);
            setLoading(false);
          }
        );
        unsubscribes.push(unsubscribe);
      });

      return () => {
        unsubscribes.forEach(unsub => unsub());
      };
    } catch (err: any) {
      console.error('Error in useSites:', err);
      setError(err.message);
      setLoading(false);
    }
  }, [userId, userSites, isAdmin]);

  const createSite = async (siteId: string, name: string, userId: string, timezone?: string): Promise<string> => {
    if (!db) throw new Error('Firebase not configured');

    // Validate site ID format
    const { isValid, error } = await import('@/lib/validators').then(m => m.validateSiteId(siteId));
    if (!isValid) {
      throw new Error(error);
    }

    // Create site document with owner field and timezone
    // Note: No pre-read existence check — non-admin users can't read sites they don't own,
    // so getDoc would fail with permission-denied. Firestore rules protect against overwrites:
    // setDoc on an existing doc triggers the 'update' rule (requires canAccessSite), so a
    // non-owner can't overwrite someone else's site. Availability is checked in CreateSiteDialog.
    const siteRef = doc(db, 'sites', siteId);
    try {
      await setDoc(siteRef, {
        name,
        createdAt: Date.now(),
        owner: userId,
        timezone: timezone || 'UTC',
      });
    } catch (err: any) {
      if (err?.code === 'permission-denied') {
        throw new Error(`Site ID "${siteId}" is already taken. Please choose a different ID.`);
      }
      throw err;
    }

    // Return the created site ID so caller can auto-switch to it
    return siteId;
  };

  const updateSite = async (siteId: string, updates: { name?: string; timezone?: string; timeFormat?: '12h' | '24h' }) => {
    if (!db) throw new Error('Firebase not configured');
    if (updates.name !== undefined && !updates.name.trim()) {
      throw new Error('Site name cannot be empty');
    }

    const updateData: Record<string, string> = {};
    if (updates.name) updateData.name = updates.name.trim();
    if (updates.timezone) updateData.timezone = updates.timezone;
    if (updates.timeFormat) updateData.timeFormat = updates.timeFormat;

    if (Object.keys(updateData).length === 0) return;

    const siteRef = doc(db, 'sites', siteId);
    await updateDoc(siteRef, updateData);
  };

  const deleteSite = async (siteId: string) => {
    if (!db) throw new Error('Firebase not configured');

    // Delete the site document
    // Note: Firestore doesn't automatically delete subcollections (machines)
    // In a production app, you might want to use a Cloud Function to handle this
    const siteRef = doc(db, 'sites', siteId);
    await deleteDoc(siteRef);

    // TODO: Clean up user references to this site
    // This should query all users with this siteId in their sites array
    // and remove it using arrayRemove. For now, admins can manually
    // clean up orphaned references via the Manage Site Access dialog.
    logger.info(`Site ${siteId} deleted. Note: User references may need manual cleanup.`);
  };

  const checkSiteIdAvailability = async (siteId: string): Promise<boolean> => {
    if (!db) throw new Error('Firebase not configured');

    // Don't check empty IDs
    if (!siteId || siteId.trim() === '') {
      return false;
    }

    // Validate format first
    const { isValid } = await import('@/lib/validators').then(m => m.validateSiteId(siteId));
    if (!isValid) {
      return false;
    }

    // Check if site exists
    const siteRef = doc(db, 'sites', siteId);
    const siteSnap = await getDoc(siteRef);

    return !siteSnap.exists();
  };

  return { sites, loading, error, createSite, updateSite, deleteSite, checkSiteIdAvailability };
}

export function useMachines(siteId: string) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Config doc overrides: authoritative launch_mode/schedules from config collection
  // This prevents the 10-second flicker on page load where status doc has stale values
  const configOverridesRef = useRef<Record<string, Record<string, { launch_mode?: string; schedules?: any; schedulePresetId?: string | null }>>>({});

  // Fetch authoritative launch_mode/schedules from config docs on mount
  // Config doc is source of truth — status doc may lag behind by 10-120s
  useEffect(() => {
    if (!db || !siteId) return;
    (async () => {
      try {
        const configCol = collection(db, 'config', siteId, 'machines');
        const configSnap = await getDocs(configCol);
        const overrides: typeof configOverridesRef.current = {};
        configSnap.forEach((docSnap) => {
          const data = docSnap.data();
          if (data.processes && Array.isArray(data.processes)) {
            const processMap: Record<string, { launch_mode?: string; schedules?: any; schedulePresetId?: string | null }> = {};
            for (const proc of data.processes) {
              if (proc.id) {
                processMap[proc.id] = {
                  launch_mode: proc.launch_mode,
                  schedules: proc.schedules,
                  schedulePresetId: proc.schedulePresetId ?? null,
                };
              }
            }
            overrides[docSnap.id] = processMap;
          }
        });
        configOverridesRef.current = overrides;

        // Apply overrides to any already-loaded machines
        setMachines(prev => prev.map(machine => {
          const machineOverrides = overrides[machine.machineId];
          if (!machineOverrides || !machine.processes) return machine;
          return {
            ...machine,
            processes: machine.processes.map(p => {
              const override = machineOverrides[p.id];
              if (!override) return p;
              return {
                ...p,
                launch_mode: (override.launch_mode || p.launch_mode) as LaunchMode,
                schedules: override.schedules ?? p.schedules,
                schedulePresetId: override.schedulePresetId,
              };
            }),
          };
        }));
      } catch (e) {
        // Non-critical — status doc values still work, just may lag
        console.debug('Config override fetch skipped:', e);
      }
    })();
  }, [siteId]);

  // Client-side heartbeat timeout checker
  // Re-evaluates machine online status every 30 seconds based on lastHeartbeat age
  // This catches machines that went offline without writing online=false (crashes, installer kills, etc.)
  useEffect(() => {
    if (machines.length === 0) return;

    const interval = setInterval(() => {
      setMachines(prevMachines => {
        const now = Math.floor(Date.now() / 1000);
        let hasChanges = false;

        const updated = prevMachines.map(machine => {
          const heartbeatAge = now - machine.lastHeartbeat;
          const shouldBeOnline = (machine.online === true) && (heartbeatAge < 180);

          // If calculated online state differs from current state, update it
          if (machine.online !== shouldBeOnline) {
            hasChanges = true;
            return { ...machine, online: shouldBeOnline };
          }
          return machine;
        });

        // Only trigger re-render if something actually changed
        return hasChanges ? updated : prevMachines;
      });
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [machines.length]); // Re-create interval when machine count changes

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      setError('Firebase not configured or no site selected');
      return;
    }

    try {
      // Listen to machines collection in real-time
      const machinesRef = collection(db, 'sites', siteId, 'machines');

      const unsubscribe = onSnapshot(
        machinesRef,
        (snapshot) => {
          setMachines(prevMachines => {
            const machineData: Machine[] = [];

            snapshot.forEach((doc) => {
              const data = doc.data();

              // Find previous machine data to preserve GPU if not in update
              const prevMachine = prevMachines.find(m => m.machineId === doc.id);

            // Parse processes from the processes object - try both locations
            let processes: Process[] = [];
            const processesData = data.metrics?.processes || data.processes;

            // Build a lookup of previous process state to preserve optimistic updates
            // and avoid flicker when metrics uploads briefly lack launch_mode during write
            const prevProcessMap: Record<string, {
              launch_mode?: LaunchMode;
              schedules?: any;
              _optimisticLaunchMode?: LaunchMode;
              _optimisticAutolaunch?: boolean;
              _optimisticSchedules?: ScheduleBlock[] | null;
              _optimisticPresetId?: string | null;
            }> = {};
            if (prevMachine?.processes) {
              for (const p of prevMachine.processes) {
                prevProcessMap[p.id] = {
                  launch_mode: p.launch_mode,
                  schedules: p.schedules,
                  _optimisticLaunchMode: p._optimisticLaunchMode,
                  _optimisticAutolaunch: p._optimisticAutolaunch,
                  _optimisticSchedules: p._optimisticSchedules,
                  _optimisticPresetId: p._optimisticPresetId,
                };
              }
            }

            if (processesData && typeof processesData === 'object') {
              processes = Object.entries(processesData)
                .map(([id, processData]: [string, any]) => {
                  const prev = prevProcessMap[id];
                  // Config doc is authoritative for launch_mode/schedules — override status doc values
                  const configOverride = configOverridesRef.current[doc.id]?.[id];
                  const firestoreMode = configOverride?.launch_mode || processData.launch_mode || prev?.launch_mode || (processData.autolaunch ? 'always' : 'off') as LaunchMode;
                  const firestoreSchedules = configOverride?.schedules ?? processData.schedules ?? prev?.schedules ?? null;
                  const firestorePresetId = configOverride?.schedulePresetId ?? processData.schedulePresetId ?? null;

                  // Preserve optimistic state until Firestore catches up
                  // Clear optimistic flag once Firestore agrees with the optimistic value
                  const optimisticMode = prev?._optimisticLaunchMode;
                  const keepOptimistic = optimisticMode !== undefined && optimisticMode !== firestoreMode;

                  return {
                    id,
                    name: processData.name || 'Unknown',
                    status: processData.status || 'UNKNOWN',
                    pid: processData.pid || null,
                    autolaunch: processData.autolaunch || false,
                    launch_mode: firestoreMode,
                    schedulePresetId: firestorePresetId,
                    schedules: firestoreSchedules,
                    exe_path: processData.exe_path || '',
                    file_path: processData.file_path || '',
                    cwd: processData.cwd || '',
                    priority: processData.priority || 'Normal',
                    visibility: processData.visibility || 'Show',
                    time_delay: processData.time_delay || '0',
                    time_to_init: processData.time_to_init || '10',
                    relaunch_attempts: processData.relaunch_attempts || '3',
                    responsive: processData.responsive ?? true,
                    last_updated: processData.last_updated || 0,
                    index: processData.index ?? 999,
                    // Carry optimistic state forward until Firestore confirms
                    ...(keepOptimistic ? {
                      _optimisticLaunchMode: prev._optimisticLaunchMode,
                      _optimisticAutolaunch: prev._optimisticAutolaunch,
                      _optimisticSchedules: prev._optimisticSchedules,
                      _optimisticPresetId: prev._optimisticPresetId,
                    } : {}),
                  };
                })
                .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
            }

            // Convert Firestore Timestamp to Unix timestamp in seconds
            let lastHeartbeat = 0;
            if (data.lastHeartbeat) {
              if (typeof data.lastHeartbeat === 'object' && 'seconds' in data.lastHeartbeat) {
                // Firestore Timestamp object
                lastHeartbeat = data.lastHeartbeat.seconds;
              } else if (typeof data.lastHeartbeat === 'number') {
                // Already a number
                lastHeartbeat = data.lastHeartbeat;
              }
            }

            // Determine online status: use both boolean flag AND heartbeat timestamp
            // Machine is online if BOTH conditions are true:
            // 1. online flag is true
            // 2. Last heartbeat was within 180 seconds
            //    Agent sends metrics every 30s (active) or 120s (idle), so 180s allows 60s buffer
            const now = Math.floor(Date.now() / 1000); // Current time in seconds
            const heartbeatAge = now - lastHeartbeat; // Age in seconds
            const isOnline = (data.online === true) && (heartbeatAge < 180);

              // Preserve GPU data if current update has invalid/missing GPU (name is "N/A" or missing)
              const metrics = data.metrics ? {
                ...data.metrics,
                gpu: (data.metrics.gpu?.name && data.metrics.gpu.name !== 'N/A')
                  ? data.metrics.gpu
                  : prevMachine?.metrics?.gpu
              } : prevMachine?.metrics;

              machineData.push({
                machineId: doc.id,
                lastHeartbeat,
                online: isOnline,
                agent_version: data.agent_version,  // Agent version for update detection
                rebootSchedule: data.rebootSchedule,
                metrics,
                processes,
              });
            });

            // Sort machines by ID for stable ordering (prevents flickering)
            machineData.sort((a, b) => a.machineId.localeCompare(b.machineId));

            return machineData;
          });
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching machines:', err);
          setError(err.message);
          setLoading(false);
        }
      );

      return () => unsubscribe();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }, [siteId]);

  const killProcess = async (machineId: string, processId: string, processName: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const commandPath = `sites/${siteId}/machines/${machineId}/commands/pending`;
    const commandId = `kill_${Date.now()}`;

    logger.debug(`Sending kill command for process "${processName}"`, {
      context: 'killProcess',
      data: { machineId, processId, commandId },
    });

    const commandRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending');
    const commandData = {
      type: 'kill_process',
      process_name: processName,
      timestamp: Date.now(),
      status: 'pending',
    };

    try {
      await setDoc(commandRef, {
        [commandId]: commandData
      }, { merge: true });

      logger.firestore.write(commandPath, commandId, 'create');
      logger.debug('Kill command sent successfully', { context: 'killProcess' });
    } catch (error) {
      logger.firestore.error('Failed to send kill command', error);
      throw error;
    }
  };

  const setLaunchMode = async (
    machineId: string, processId: string, processName: string,
    mode: LaunchMode, schedules?: ScheduleBlock[] | null, schedulePresetId?: string | null
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    // Optimistically update the UI immediately
    // These fields persist until the Firestore listener confirms the change
    setMachines(prevMachines =>
      prevMachines.map(machine => {
        if (machine.machineId === machineId) {
          return {
            ...machine,
            processes: machine.processes?.map(process => {
              if (process.id === processId) {
                return {
                  ...process,
                  _optimisticLaunchMode: mode,
                  _optimisticAutolaunch: mode !== 'off',
                  _optimisticSchedules: schedules ?? process.schedules,
                  _optimisticPresetId: schedulePresetId,
                };
              }
              return process;
            })
          };
        }
        return machine;
      })
    );

    // Update config overrides ref so subsequent listener fires use the new value
    if (!configOverridesRef.current[machineId]) configOverridesRef.current[machineId] = {};
    configOverridesRef.current[machineId][processId] = {
      launch_mode: mode,
      schedules: schedules ?? undefined,
      schedulePresetId: schedulePresetId,
    };

    const configRef = doc(db, 'config', siteId, 'machines', machineId);
    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Setting launch mode for "${processName}" to ${mode}`, {
      context: 'setLaunchMode',
      data: { machineId, processId, mode },
    });

    try {
      // Write directly to config document (bypasses command queue for faster sync)
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        throw new Error('Configuration not found');
      }

      const config = configSnap.data();
      if (!config.processes || !Array.isArray(config.processes)) {
        throw new Error('Invalid configuration structure');
      }

      // Strip undefined values from schedule blocks (Firestore rejects undefined)
      const cleanSchedules = schedules?.map(b => {
        const clean: Record<string, unknown> = { days: b.days, ranges: b.ranges };
        if (b.name) clean.name = b.name;
        if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
        return clean;
      });

      const updatedProcesses = config.processes.map((proc: any) =>
        proc.name === processName ? {
          ...proc,
          launch_mode: mode,
          autolaunch: mode !== 'off',
          ...(cleanSchedules !== undefined ? { schedules: cleanSchedules } : {}),
          ...(schedulePresetId !== undefined ? { schedulePresetId: schedulePresetId || null } : {}),
        } : proc
      );

      await updateDoc(configRef, { processes: updatedProcesses });
      logger.firestore.write(configPath, undefined, 'update');

      // Mirror launch_mode + schedules to status doc for immediate UI visibility
      // configChangeFlag signals the agent to pick up config changes
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, {
          configChangeFlag: true,
          [`metrics.processes.${processId}.launch_mode`]: mode,
          [`metrics.processes.${processId}.autolaunch`]: mode !== 'off',
          ...(cleanSchedules !== undefined ? { [`metrics.processes.${processId}.schedules`]: cleanSchedules } : {}),
          ...(schedulePresetId !== undefined ? { [`metrics.processes.${processId}.schedulePresetId`]: schedulePresetId || null } : {}),
        });
      } catch (flagError) {
        logger.debug('Status doc mirror write skipped (non-critical)', { context: 'setLaunchMode' });
      }

      logger.debug('Launch mode set via config system', { context: 'setLaunchMode' });
    } catch (error) {
      logger.firestore.error('Failed to set launch mode', error);
      throw error;
    }
  };

  const updateProcess = async (machineId: string, processId: string, updatedData: Partial<Process>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configRef = doc(db, 'config', siteId, 'machines', machineId);
    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Updating process "${processId}"`, {
      context: 'updateProcess',
      data: { machineId, processId, updatedData },
    });

    try {
      logger.firestore.read(configPath);

      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        logger.error('Config document not found', { context: 'updateProcess', data: { configPath } });
        throw new Error('Configuration not found');
      }

      const config = configSnap.data();

      if (!config.processes || !Array.isArray(config.processes)) {
        logger.error('Invalid config structure - no processes array', { context: 'updateProcess' });
        throw new Error('Invalid configuration structure');
      }

      const targetProcess = config.processes.find((proc: any) => proc.id === processId);
      if (!targetProcess) {
        logger.error('Process not found in config', { context: 'updateProcess', data: { processId } });
        throw new Error('Process not found');
      }

      // Clean schedule blocks to strip undefined values (Firestore rejects undefined)
      const cleanedData = { ...updatedData };
      if (cleanedData.schedules) {
        cleanedData.schedules = cleanedData.schedules.map(b => {
          const clean: any = { days: b.days, ranges: b.ranges };
          if (b.name) clean.name = b.name;
          if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
          return clean;
        });
      }

      const updatedProcesses = config.processes.map((proc: any) =>
        proc.id === processId ? { ...proc, ...cleanedData } : proc
      );

      await updateDoc(configRef, {
        processes: updatedProcesses
      });

      logger.firestore.write(configPath, undefined, 'update');
      logger.debug('Process updated successfully', { context: 'updateProcess' });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch (flagError) {
        logger.debug('configChangeFlag write skipped (non-critical)', { context: 'updateProcess' });
      }
    } catch (error: any) {
      logger.firestore.error('Failed to update process', error);

      // Enhanced error logging for debugging
      console.error('[Firestore Error] updateProcess failed:', {
        error,
        code: error?.code,
        message: error?.message,
        siteId,
        machineId,
        processId
      });

      // Provide more descriptive error messages for common Firestore errors
      if (error?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to update process configuration. Please check Firestore security rules.');
      } else if (error?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (error?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const deleteProcess = async (machineId: string, processId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configRef = doc(db, 'config', siteId, 'machines', machineId);
    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Deleting process "${processId}"`, {
      context: 'deleteProcess',
      data: { machineId, processId },
    });

    try {
      logger.firestore.read(configPath);

      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        logger.error('Config document not found', { context: 'deleteProcess', data: { configPath } });
        throw new Error('Configuration not found');
      }

      const config = configSnap.data();

      if (!config.processes || !Array.isArray(config.processes)) {
        logger.error('Invalid config structure - no processes array', { context: 'deleteProcess' });
        throw new Error('Invalid configuration structure');
      }

      const targetProcess = config.processes.find((proc: any) => proc.id === processId);
      if (!targetProcess) {
        logger.error('Process not found in config', { context: 'deleteProcess', data: { processId } });
        throw new Error('Process not found');
      }

      const updatedProcesses = config.processes.filter((proc: any) => proc.id !== processId);

      await updateDoc(configRef, {
        processes: updatedProcesses
      });

      logger.firestore.write(configPath, undefined, 'delete');
      logger.debug('Process deleted successfully', { context: 'deleteProcess' });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch (flagError) {
        logger.debug('configChangeFlag write skipped (non-critical)', { context: 'deleteProcess' });
      }
    } catch (error: any) {
      logger.firestore.error('Failed to delete process', error);

      // Enhanced error logging for debugging
      console.error('[Firestore Error] deleteProcess failed:', {
        error,
        code: error?.code,
        message: error?.message,
        siteId,
        machineId,
        processId
      });

      // Provide more descriptive error messages for common Firestore errors
      if (error?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to delete process configuration. Please check Firestore security rules.');
      } else if (error?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (error?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const createProcess = async (machineId: string, processData: Partial<Process>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configRef = doc(db, 'config', siteId, 'machines', machineId);
    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug('Creating new process', {
      context: 'createProcess',
      data: { machineId, processData },
    });

    try {
      logger.firestore.read(configPath);

      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        logger.error('Config document not found', { context: 'createProcess', data: { configPath } });
        throw new Error('Configuration not found');
      }

      const config = configSnap.data();

      if (!config.processes || !Array.isArray(config.processes)) {
        logger.error('Invalid config structure - no processes array', { context: 'createProcess' });
        throw new Error('Invalid configuration structure');
      }

      const newProcessId = crypto.randomUUID();

      const newProcess = {
        id: newProcessId,
        name: processData.name || 'New Process',
        exe_path: processData.exe_path || '',
        file_path: processData.file_path || '',
        cwd: processData.cwd || '',
        priority: processData.priority || 'Normal',
        visibility: processData.visibility || 'Show',
        time_delay: processData.time_delay || '0',
        time_to_init: processData.time_to_init || '10',
        relaunch_attempts: processData.relaunch_attempts || '3',
        autolaunch: processData.autolaunch ?? false,
        launch_mode: processData.launch_mode || 'off',
        schedules: processData.schedules || null
      };

      const updatedProcesses = [...config.processes, newProcess];

      await updateDoc(configRef, {
        processes: updatedProcesses
      });

      logger.firestore.write(configPath, undefined, 'create');
      logger.debug('Process created successfully', { context: 'createProcess', data: { newProcessId } });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch (flagError) {
        logger.debug('configChangeFlag write skipped (non-critical)', { context: 'createProcess' });
      }

      return newProcessId;
    } catch (error: any) {
      logger.firestore.error('Failed to create process', error);

      // Enhanced error logging for debugging
      console.error('[Firestore Error] createProcess failed:', {
        error,
        code: error?.code,
        message: error?.message,
        siteId,
        machineId,
        processData
      });

      // Provide more descriptive error messages for common Firestore errors
      if (error?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to create process configuration. Please check Firestore security rules.');
      } else if (error?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (error?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const sendMachineCommand = async (machineId: string, commandType: string, extraData: Record<string, any> = {}) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const commandId = `${commandType}_${Date.now()}`;
    const commandRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending');
    const commandData = {
      type: commandType,
      timestamp: Date.now(),
      status: 'pending',
      ...extraData,
    };

    await setDoc(commandRef, {
      [commandId]: commandData
    }, { merge: true });
  };

  const rebootMachine = async (machineId: string) => {
    await sendMachineCommand(machineId, 'reboot_machine');
  };

  const shutdownMachine = async (machineId: string) => {
    await sendMachineCommand(machineId, 'shutdown_machine');
  };

  const cancelReboot = async (machineId: string) => {
    await sendMachineCommand(machineId, 'cancel_reboot');
  };

  const dismissRebootPending = async (machineId: string, processName: string) => {
    await sendMachineCommand(machineId, 'dismiss_reboot_pending', { process_name: processName });
  };

  const captureScreenshot = async (machineId: string) => {
    await sendMachineCommand(machineId, 'capture_screenshot');
  };

  const startLiveView = async (machineId: string, interval: number = 10, duration: number = 600) => {
    await sendMachineCommand(machineId, 'start_live_view', { interval, duration });
  };

  const stopLiveView = async (machineId: string) => {
    await sendMachineCommand(machineId, 'stop_live_view');
  };

  return { machines, loading, error, killProcess, setLaunchMode, updateProcess, deleteProcess, createProcess, rebootMachine, shutdownMachine, cancelReboot, dismissRebootPending, captureScreenshot, startLiveView, stopLiveView };
}
