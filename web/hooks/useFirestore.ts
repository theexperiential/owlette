'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc, deleteDoc, updateDoc, getDoc, runTransaction, serverTimestamp, type Unsubscribe } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { logger } from '@/lib/logger';

/**
 * Robustly parse a Firestore timestamp-shaped value into Unix seconds.
 *
 * Returns 0 for falsy / unparseable inputs (which downstream code interprets as
 * "no value" — formatHeartbeatTime renders `--`, isOnline returns false).
 *
 * Necessary because Firebase JS SDK can return the same logical timestamp in
 * several different shapes depending on listener path, cache rehydration,
 * persistence layer, and SDK version. The previous parser only handled
 * `Timestamp` instances and plain numbers, silently dropping every other shape
 * (including plain `{seconds, nanoseconds}` objects rehydrated from cache),
 * which manifested as a flapping online/offline pill on the dashboard.
 */
function parseFirestoreSeconds(value: any): number {
  if (value == null) return 0;

  // Number (already in Unix seconds — written by client code or hook itself)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  // Object — could be Firebase Timestamp instance, plain {seconds, nanoseconds},
  // legacy admin SDK {_seconds, _nanoseconds}, or a JS Date.
  if (typeof value === 'object') {
    // Firebase Timestamp instance — has toMillis(); prefer it for accuracy
    if (typeof value.toMillis === 'function') {
      try {
        const ms = value.toMillis();
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
      } catch {
        // fall through to property reads
      }
    }
    // Plain {seconds, nanoseconds} — emitted by cache rehydration in some SDK paths
    if (typeof value.seconds === 'number') return value.seconds;
    // Legacy admin-SDK shape {_seconds, _nanoseconds}
    if (typeof value._seconds === 'number') return value._seconds;
    // JS Date (defensive — shouldn't reach client this way, but handle it)
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  }

  // String — defensive parse for ISO datetime strings (some Firestore code
  // paths return timestamps as ISO strings rather than Timestamp objects)
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }

  return 0;
}

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

/** A single scheduled reboot entry — fires once per matching day at the given time. */
export interface RebootScheduleEntry {
  id: string;       // crypto.randomUUID() at creation, stable across edits
  days: string[];   // e.g. ['mon','tue','wed','thu','fri']
  time: string;     // "HH:MM" 24h
}

export interface RebootSchedule {
  enabled: boolean;
  entries: RebootScheduleEntry[];
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

export interface CpuProfile {
  id: string;              // "CPU0", "CPU1", ...
  model: string;
  physicalCores: number;
  logicalCores: number;
  socketIndex: number;
}

export interface DiskProfile {
  id: string;              // mountpoint, e.g. "C:"
  label: string;
  fs: string;
  totalGb: number;
}

export interface GpuProfile {
  id: string;              // UUID or hash
  name: string;
  vramTotalGb: number;
  pciBus: string | null;
}

export interface NicProfile {
  id: string;              // interface name, e.g. "Ethernet 2"
  mac: string | null;
  linkSpeedMbps: number;
}

export interface HardwareProfile {
  schemaVersion: number;
  signatureHash: string;
  capturedAt: any;         // Firestore Timestamp or number
  agentVersion: string;
  cpus: CpuProfile[];
  disks: DiskProfile[];
  gpus: GpuProfile[];
  nics: NicProfile[];
}

export interface CpuMetric   { percent: number; temperature?: number | null }
export interface MemoryMetric { percent: number; usedGb: number }
export interface DiskMetric  { percent: number; usedGb: number }
export interface GpuMetric   { usagePercent: number; vramUsedGb: number; temperature?: number | null }
export interface NicMetric   { txBps: number; rxBps: number; txUtil: number; rxUtil: number }
export interface NetworkMetric { latencyMs?: number | null; packetLossPct?: number | null; gatewayIp?: string | null }

export interface PrimaryDevices {
  cpu?: string | null;
  disk?: string | null;
  gpu?: string | null;
  nic?: string | null;
}

/**
 * Joined view of a profiled device (CPU / disk / GPU / NIC) with its live metric.
 *
 * - `isMissing`  true when the profile entry exists but no matching metric key
 *                 was found in the most recent metrics upload (agent hasn't
 *                 reported it yet, or it's transiently absent).
 * - `isOrphan`   true when a metric key exists but there's no matching profile
 *                 entry (hardware changed since last profile capture — shown
 *                 with a "syncing" indicator until the agent re-uploads the
 *                 profile doc).
 *
 * Orphan entries carry the metric plus a synthesized profile shell (id/label
 * only), so the profile half is `Partial<P>` rather than the full `P`.
 */
export type DeviceEntry<P, M> = Partial<P> & Partial<M> & {
  id: string;
  isMissing: boolean;
  isOrphan: boolean;
};

export interface Machine {
  machineId: string;
  lastHeartbeat: number;
  online: boolean;
  agent_version?: string;  // Agent version for update detection (e.g., "2.0.0")
  machineTimezone?: string;  // IANA timezone (e.g. "America/Los_Angeles") from agent's tzlocal lookup. Undefined if the agent has not yet deployed the IANA-aware build.
  cortexEnabled?: boolean;  // User-controlled kill switch for Cortex tool-call delivery. Undefined/true = enabled.
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — countdown anchor (matches lastHeartbeat convention)
  shutdownScheduledAt?: number;
  rebootPending?: {
    active: boolean;
    processName: string | null;
    reason: string | null;
    timestamp: number | null;
  };
  rebootSchedule?: RebootSchedule;
  rebootState?: {
    lastFiredByEntry?: { [entryId: string]: string }; // ISO date "YYYY-MM-DD"
    attempt?: {
      entryId: string;
      scheduledFor: string;       // ISO instant
      lastAttemptAt: any;         // Firestore Timestamp
      status: 'pending' | 'failed';
    } | null;
  };
  lastScreenshot?: {
    url: string;       // Firebase Storage public URL
    timestamp: any;    // Firestore Timestamp (new) or number (legacy)
    sizeKB: number;
  };
  liveView?: {
    active: boolean;
    interval?: number;
    startedAt?: number;
    expiresAt?: number;
  };
  metrics?: {
    schemaVersion?: number;
    profileHash?: string;
    timestamp?: any;
    cpus?:   Record<string, CpuMetric>;
    memory?: MemoryMetric;
    disks?:  Record<string, DiskMetric>;
    gpus?:   Record<string, GpuMetric>;
    nics?:   Record<string, NicMetric>;
    network?: NetworkMetric & {
      /** @deprecated v1 legacy — per-interface map moved to top-level `metrics.nics` in v2. Kept for rollout-window shim. */
      interfaces?: Record<string, {
        tx_bps: number;
        rx_bps: number;
        tx_util: number;
        rx_util: number;
        link_speed: number;
      }>;
      /** @deprecated v1 legacy — use `gatewayIp` (v2). */
      gateway_ip?: string | null;
      /** @deprecated v1 legacy — use `latencyMs` (v2). */
      latency_ms?: number | null;
      /** @deprecated v1 legacy — use `packetLossPct` (v2). */
      packet_loss_pct?: number | null;
    };
    primary?: PrimaryDevices;
    processes?: Record<string, string>;

    /**
     * Aggregate disk IO (system-wide, not per-volume). Sibling of `disks` —
     * agent-side aggregate keys (physical drives) don't align with logical
     * volume keys (C:, D:). Populated by agents >= v2.8.2.
     */
    diskio?: {
      readBps: number;
      writeBps: number;
      readIops: number;
      writeIops: number;
      busyPct: number;
    };

    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    cpu?: { name?: string; percent: number; unit: string; temperature?: number };
    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    disk?: { percent: number; total_gb: number; used_gb: number; unit: string };
    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    gpu?: { name: string; usage_percent: number; vram_total_gb: number; vram_used_gb: number; unit: string; temperature?: number };
  };
  profile?: HardwareProfile;
  /**
   * Joined profile + metrics view. Populated by `useMachines` after the
   * per-machine `hardware/profile` doc and the live metrics have both arrived.
   * Orphan entries (metrics key with no matching profile entry) are appended
   * with `isOrphan: true`; profiled devices with no current metric carry
   * `isMissing: true`.
   */
  devices?: {
    cpus: DeviceEntry<CpuProfile, CpuMetric>[];
    disks: DeviceEntry<DiskProfile, DiskMetric>[];
    gpus: DeviceEntry<GpuProfile, GpuMetric>[];
    nics: DeviceEntry<NicProfile, NicMetric>[];
  };
  processes?: Process[];
}

export interface Site {
  id: string;
  name: string;
  createdAt: any; // Firestore Timestamp (new) or number (legacy)
  timezone?: string;  // IANA timezone, e.g., "America/New_York"
  owner?: string;  // UID of the user who owns this site
}

// DELETE once all agents are >= 2.9.0
const LEGACY_METRICS_SHIM = true;

/**
 * Synthesize v2-shaped `metrics` and `profile` from a legacy (schemaVersion < 2)
 * machine doc, so downstream code can always assume the v2 layout.
 *
 * Returns a shallow clone of the input machine with `metrics` and `profile`
 * replaced by synthesized v2 equivalents. If the machine already looks v2
 * (or there's nothing to shim), returns the input unchanged.
 */
function shimLegacyMachine(machine: Machine): Machine {
  if (!LEGACY_METRICS_SHIM) return machine;

  const legacy = machine.metrics;
  if (!legacy) return machine;
  // Already v2 — nothing to do.
  if (legacy.schemaVersion === 2) return machine;
  // Only shim if the legacy singular field is present (otherwise this is
  // an empty/placeholder metrics object and there's nothing to synthesize).
  if (!legacy.cpu) return machine;

  const legacyNetwork = legacy.network ?? {};
  const legacyInterfaces = legacyNetwork.interfaces ?? {};
  const firstNicId = Object.keys(legacyInterfaces)[0];

  const cpus: Record<string, CpuMetric> = {
    CPU0: {
      percent: legacy.cpu.percent,
      temperature: legacy.cpu.temperature ?? null,
    },
  };

  const disks: Record<string, DiskMetric> = legacy.disk
    ? { 'C:': { percent: legacy.disk.percent, usedGb: legacy.disk.used_gb } }
    : {};

  const gpus: Record<string, GpuMetric> = legacy.gpu
    ? {
        GPU0: {
          usagePercent: legacy.gpu.usage_percent,
          vramUsedGb: legacy.gpu.vram_used_gb,
          temperature: legacy.gpu.temperature ?? null,
        },
      }
    : {};

  const nics: Record<string, NicMetric> = {};
  for (const [id, n] of Object.entries(legacyInterfaces)) {
    nics[id] = {
      txBps: n.tx_bps,
      rxBps: n.rx_bps,
      txUtil: n.tx_util,
      rxUtil: n.rx_util,
    };
  }

  // Legacy memory is snake_case at runtime (`used_gb`) even though the TS
  // type claims camelCase — the v2 interface describes the post-shim shape.
  // Read via a narrow structural type and normalize.
  const legacyMemory = legacy.memory as unknown as
    | { percent: number; used_gb?: number; usedGb?: number }
    | undefined;
  const memory: MemoryMetric | undefined = legacyMemory
    ? {
        percent: legacyMemory.percent,
        usedGb: legacyMemory.used_gb ?? legacyMemory.usedGb ?? 0,
      }
    : undefined;

  const network: NetworkMetric = {
    latencyMs: legacyNetwork.latency_ms ?? null,
    packetLossPct: legacyNetwork.packet_loss_pct ?? null,
    gatewayIp: legacyNetwork.gateway_ip ?? null,
  };

  const primary: PrimaryDevices = {
    cpu: 'CPU0',
    disk: legacy.disk ? 'C:' : null,
    gpu: legacy.gpu ? 'GPU0' : null,
    nic: firstNicId ?? null,
  };

  const shimmedMetrics: Machine['metrics'] = {
    ...legacy,
    schemaVersion: 2,
    cpus,
    disks,
    gpus,
    nics,
    memory,
    network,
    primary,
  };

  const shimmedProfile: HardwareProfile = {
    schemaVersion: 0,
    signatureHash: 'legacy',
    capturedAt: 0,
    agentVersion: 'legacy',
    cpus: [{
      id: 'CPU0',
      model: legacy.cpu.name || 'Unknown',
      physicalCores: 0,
      logicalCores: 0,
      socketIndex: 0,
    }],
    disks: legacy.disk
      ? [{ id: 'C:', label: 'System', fs: 'NTFS', totalGb: legacy.disk.total_gb }]
      : [],
    gpus: legacy.gpu
      ? [{
          id: 'GPU0',
          name: legacy.gpu.name,
          vramTotalGb: legacy.gpu.vram_total_gb,
          pciBus: null,
        }]
      : [],
    nics: Object.entries(legacyInterfaces).map(([id, n]) => ({
      id,
      mac: null,
      linkSpeedMbps: n.link_speed,
    })),
  };

  // If the machine already has a real profile (e.g. a v2 agent uploaded its
  // profile doc but its next metrics write is still legacy-shaped during the
  // rollout window), preserve it — only synthesize a profile when none exists.
  return {
    ...machine,
    metrics: shimmedMetrics,
    profile: machine.profile ?? shimmedProfile,
  };
}

/**
 * Join a machine's `metrics` with its `profile` to produce the `devices`
 * field. Profiled devices with no current metric are flagged `isMissing`;
 * metric keys with no matching profile entry are appended as orphans.
 */
function joinMachineDevices(machine: Machine): Machine {
  const profile = machine.profile;
  const metrics = machine.metrics;
  if (!profile) return machine;

  const buildBucket = <P extends { id: string }, M>(
    profileList: P[] | undefined,
    metricMap: Record<string, M> | undefined,
  ): DeviceEntry<P, M>[] => {
    const result: DeviceEntry<P, M>[] = [];
    const seen = new Set<string>();
    for (const p of profileList ?? []) {
      const metric = metricMap?.[p.id];
      result.push({
        ...p,
        ...(metric ?? {}),
        isMissing: !metric,
        isOrphan: false,
      } as unknown as DeviceEntry<P, M>);
      seen.add(p.id);
    }
    // Orphans: metric keys not present in the profile.
    for (const [id, metric] of Object.entries(metricMap ?? {})) {
      if (seen.has(id)) continue;
      result.push({
        id,
        ...(metric as M),
        isMissing: false,
        isOrphan: true,
      } as unknown as DeviceEntry<P, M>);
    }
    return result;
  };

  const devices = {
    cpus: buildBucket<CpuProfile, CpuMetric>(profile.cpus, metrics?.cpus),
    disks: buildBucket<DiskProfile, DiskMetric>(profile.disks, metrics?.disks),
    gpus: buildBucket<GpuProfile, GpuMetric>(profile.gpus, metrics?.gpus),
    nics: buildBucket<NicProfile, NicMetric>(profile.nics, metrics?.nics),
  };

  return { ...machine, devices };
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
                owner: data.owner,
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
                owner: data.owner,
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
        createdAt: serverTimestamp(),
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
  const [profiles, setProfiles] = useState<Record<string, HardwareProfile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-machine hardware/profile listeners. Keyed by machineId; opened lazily
  // when a machine appears in the snapshot and torn down when it disappears
  // or when siteId changes / the hook unmounts.
  const profileListenersRef = useRef<Record<string, Unsubscribe>>({});

  // Config doc overrides: authoritative launch_mode/schedules from config collection
  // This prevents the 10-second flicker on page load where status doc has stale values
  const configOverridesRef = useRef<Record<string, Record<string, { launch_mode?: string; schedules?: any; schedulePresetId?: string | null }>>>({});

  // Reboot schedule lives in the config doc (not the status doc) so it can be
  // pushed down to the agent's local cache and survive Firestore disconnections.
  const rebootScheduleOverridesRef = useRef<Record<string, RebootSchedule | undefined>>({});

  // Real-time listener on config docs for authoritative launch_mode/schedules.
  // Config doc is source of truth — status doc may lag behind by 10-120s.
  // Using onSnapshot (not getDocs) so agent-originated changes propagate to the web.
  useEffect(() => {
    if (!db || !siteId) return;
    const configCol = collection(db, 'config', siteId, 'machines');
    const unsubConfig = onSnapshot(configCol, (snapshot) => {
      const overrides: typeof configOverridesRef.current = {};
      const rebootOverrides: typeof rebootScheduleOverridesRef.current = {};
      snapshot.forEach((docSnap) => {
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
        // Reboot schedule lives in the config doc per the offline-capable design.
        if (data.rebootSchedule) {
          rebootOverrides[docSnap.id] = data.rebootSchedule as RebootSchedule;
        }
      });
      configOverridesRef.current = overrides;
      rebootScheduleOverridesRef.current = rebootOverrides;

      // Apply overrides to any already-loaded machines
      setMachines(prev => prev.map(machine => {
        const machineOverrides = overrides[machine.machineId];
        const rebootSchedule = rebootOverrides[machine.machineId];
        const next: Machine = { ...machine, rebootSchedule };
        if (machineOverrides && next.processes) {
          next.processes = next.processes.map(p => {
            const override = machineOverrides[p.id];
            if (!override) return p;
            return {
              ...p,
              launch_mode: (override.launch_mode || p.launch_mode) as LaunchMode,
              schedules: override.schedules ?? p.schedules,
              schedulePresetId: override.schedulePresetId,
            };
          });
        }
        return next;
      }));
    }, (e) => {
      // Non-critical — status doc values still work, just may lag
      console.debug('Config override listener error:', e);
    });
    return () => unsubConfig();
  }, [siteId]);

  // Client-side heartbeat timeout checker
  // Re-evaluates machine online status every 30 seconds based on lastHeartbeat age
  // This catches machines that went offline without writing online=false (crashes, installer kills, etc.)
  //
  // IMPORTANT: if `lastHeartbeat === 0` (parser fell through, or doc just
  // arrived without a heartbeat field), do NOT aggressively flip the machine
  // offline. Trust `machine.online` from the snapshot listener until we have
  // a real heartbeat to compare against. Without this guard, any timestamp
  // shape the parser doesn't recognize causes a flapping online/offline pill
  // every 30s as this interval fires.
  useEffect(() => {
    if (machines.length === 0) return;

    const interval = setInterval(() => {
      setMachines(prevMachines => {
        const now = Math.floor(Date.now() / 1000);
        let hasChanges = false;

        const updated = prevMachines.map(machine => {
          // Skip the staleness check entirely if we have no usable heartbeat —
          // trust the snapshot's online flag rather than spuriously flipping offline.
          if (!machine.lastHeartbeat || machine.lastHeartbeat <= 0) {
            return machine;
          }
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
    if (!db) {
      setLoading(false);
      setError('Firebase not configured');
      return;
    }
    if (!siteId) {
      // Keep loading=true while waiting for the parent to resolve currentSiteId.
      // Otherwise the dashboard sees machinesLoading=false + machines=[] on the
      // first render after refresh and briefly renders the getting-started card.
      setLoading(true);
      setMachines([]);
      return;
    }

    // Reset on siteId change so stale data from the previous site doesn't render
    // while the new listener's first snapshot is in flight.
    setLoading(true);
    setMachines([]);

    try {
      // Listen to machines collection in real-time
      const machinesRef = collection(db, 'sites', siteId, 'machines');

      const unsubscribe = onSnapshot(
        machinesRef,
        (snapshot) => {
          // When the snapshot is served from local cache (e.g. on remount after
          // navigating back to the dashboard), `lastHeartbeat` is whatever was
          // cached last — wall-clock "now" has advanced but the cached timestamp
          // hasn't, so the heartbeat-age check below would spuriously flip every
          // machine to offline for a split second until the server snapshot
          // arrives. Skip the age check on cached reads and trust `data.online`;
          // the follow-up server snapshot (ms later) re-applies the full check,
          // and the 30s interval still catches silent crashes.
          const isFromCache = snapshot.metadata.fromCache;

          // Reconcile per-machine hardware/profile listeners with the current
          // set of machines. Open a listener for any newly appearing machine;
          // tear down listeners for machines that disappeared.
          const currentMachineIds = new Set<string>();
          snapshot.forEach((d) => currentMachineIds.add(d.id));

          // Open listeners for new machines
          for (const machineId of currentMachineIds) {
            if (profileListenersRef.current[machineId]) continue;
            const profileRef = doc(db!, 'sites', siteId, 'machines', machineId, 'hardware', 'profile');
            profileListenersRef.current[machineId] = onSnapshot(
              profileRef,
              (profileSnap) => {
                if (!profileSnap.exists()) {
                  setProfiles((prev) => {
                    if (!(machineId in prev)) return prev;
                    const next = { ...prev };
                    delete next[machineId];
                    return next;
                  });
                  return;
                }
                const profileData = profileSnap.data() as HardwareProfile;
                setProfiles((prev) => ({ ...prev, [machineId]: profileData }));
              },
              (e) => {
                // Non-critical — profile is supplementary; metrics still render.
                console.debug(`Profile listener error for ${machineId}:`, e);
              },
            );
          }

          // Tear down listeners for machines no longer present
          for (const machineId of Object.keys(profileListenersRef.current)) {
            if (currentMachineIds.has(machineId)) continue;
            profileListenersRef.current[machineId]();
            delete profileListenersRef.current[machineId];
            setProfiles((prev) => {
              if (!(machineId in prev)) return prev;
              const next = { ...prev };
              delete next[machineId];
              return next;
            });
          }

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

            // Convert Firestore Timestamp to Unix timestamp in seconds.
            // Handles every shape Firestore can return depending on listener
            // path / cache / persistence layer:
            //   - Firebase Timestamp instance ({ seconds, nanoseconds, toMillis() })
            //   - Plain object { seconds, nanoseconds } (from cache rehydration)
            //   - Plain object with `_seconds` (legacy admin SDK shape)
            //   - Number (already in Unix seconds — written by client code)
            //   - ISO string (defensive — agent shouldn't write this, but parse if it does)
            //   - JS Date instance
            const lastHeartbeat = parseFirestoreSeconds(data.lastHeartbeat);

            // Convert reboot/shutdown countdown anchors using the same robust parser.
            const rebootScheduledAtParsed = parseFirestoreSeconds(data.rebootScheduledAt);
            const rebootScheduledAt = rebootScheduledAtParsed > 0 ? rebootScheduledAtParsed : undefined;
            const shutdownScheduledAtParsed = parseFirestoreSeconds(data.shutdownScheduledAt);
            const shutdownScheduledAt = shutdownScheduledAtParsed > 0 ? shutdownScheduledAtParsed : undefined;

            // Determine online status: use both boolean flag AND heartbeat timestamp
            // Machine is online if BOTH conditions are true:
            // 1. online flag is true
            // 2. Last heartbeat was within 180 seconds
            //    Agent sends metrics every 30s (active) or 120s (idle), so 180s allows 60s buffer
            // Exception: on cached snapshots the heartbeat age is unreliable, so trust the flag alone.
            const now = Math.floor(Date.now() / 1000); // Current time in seconds
            const heartbeatAge = now - lastHeartbeat; // Age in seconds
            const isOnline = isFromCache
              ? (data.online === true)
              : (data.online === true) && (heartbeatAge < 180);

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
                machineTimezone: typeof data.machine_timezone_iana === 'string' ? data.machine_timezone_iana : undefined,
                rebooting: data.rebooting,
                shuttingDown: data.shuttingDown,
                rebootScheduledAt,
                shutdownScheduledAt,
                // rebootSchedule lives in the config doc — sourced from rebootScheduleOverridesRef
                rebootSchedule: rebootScheduleOverridesRef.current[doc.id],
                rebootState: data.rebootState,
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

      return () => {
        unsubscribe();
        // Tear down every per-machine profile listener opened by this effect
        // instance. Next effect run (new siteId or remount) will re-open them.
        for (const machineId of Object.keys(profileListenersRef.current)) {
          profileListenersRef.current[machineId]();
        }
        profileListenersRef.current = {};
        setProfiles({});
      };
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
      timestamp: serverTimestamp(),
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
      // Strip undefined values from schedule blocks (Firestore rejects undefined)
      const cleanSchedules = schedules?.map(b => {
        const clean: Record<string, unknown> = { days: b.days, ranges: b.ranges };
        if (b.name) clean.name = b.name;
        if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
        return clean;
      });

      // Use a transaction to prevent race conditions from rapid clicks
      // (non-transactional read-modify-write can clobber concurrent changes)
      await runTransaction(db, async (transaction) => {
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) {
          throw new Error('Configuration not found');
        }

        const config = configSnap.data();
        if (!config.processes || !Array.isArray(config.processes)) {
          throw new Error('Invalid configuration structure');
        }

        const updatedProcesses = config.processes.map((proc: any) =>
          proc.name === processName ? {
            ...proc,
            launch_mode: mode,
            autolaunch: mode !== 'off',
            ...(cleanSchedules !== undefined ? { schedules: cleanSchedules } : {}),
            ...(schedulePresetId !== undefined ? { schedulePresetId: schedulePresetId || null } : {}),
          } : proc
        );

        transaction.update(configRef, { processes: updatedProcesses });
      });
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
      } catch {
        logger.debug('Status doc mirror write skipped (non-critical)', { context: 'setLaunchMode' });
      }

      logger.debug('Launch mode set via config system', { context: 'setLaunchMode' });
    } catch (error) {
      // Roll back optimistic update on failure
      setMachines(prevMachines =>
        prevMachines.map(machine => {
          if (machine.machineId === machineId) {
            return {
              ...machine,
              processes: machine.processes?.map(process => {
                if (process.id === processId) {
                  const { _optimisticLaunchMode, _optimisticAutolaunch, _optimisticSchedules, _optimisticPresetId, ...rest } = process;
                  return rest;
                }
                return process;
              })
            };
          }
          return machine;
        })
      );
      // Clear config override so listener doesn't re-apply stale optimistic values
      if (configOverridesRef.current[machineId]) {
        delete configOverridesRef.current[machineId][processId];
      }
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

      await runTransaction(db, async (transaction) => {
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) {
          throw new Error('Configuration not found');
        }

        const config = configSnap.data();
        if (!config.processes || !Array.isArray(config.processes)) {
          throw new Error('Invalid configuration structure');
        }

        const targetProcess = config.processes.find((proc: any) => proc.id === processId);
        if (!targetProcess) {
          throw new Error('Process not found');
        }

        const updatedProcesses = config.processes.map((proc: any) =>
          proc.id === processId ? { ...proc, ...cleanedData } : proc
        );

        transaction.update(configRef, { processes: updatedProcesses });
      });

      logger.firestore.write(configPath, undefined, 'update');
      logger.debug('Process updated successfully', { context: 'updateProcess' });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch {
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
      await runTransaction(db, async (transaction) => {
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) {
          throw new Error('Configuration not found');
        }

        const config = configSnap.data();
        if (!config.processes || !Array.isArray(config.processes)) {
          throw new Error('Invalid configuration structure');
        }

        const targetProcess = config.processes.find((proc: any) => proc.id === processId);
        if (!targetProcess) {
          throw new Error('Process not found');
        }

        const updatedProcesses = config.processes.filter((proc: any) => proc.id !== processId);
        transaction.update(configRef, { processes: updatedProcesses });
      });

      logger.firestore.write(configPath, undefined, 'delete');
      logger.debug('Process deleted successfully', { context: 'deleteProcess' });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch {
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
      const newProcessId = crypto.randomUUID();

      const newProcess = {
        id: newProcessId,
        name: processData.name || 'Untitled Process',
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

      await runTransaction(db, async (transaction) => {
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) {
          throw new Error('Configuration not found');
        }

        const config = configSnap.data();
        if (!config.processes || !Array.isArray(config.processes)) {
          throw new Error('Invalid configuration structure');
        }

        const updatedProcesses = [...config.processes, newProcess];
        transaction.update(configRef, { processes: updatedProcesses });
      });

      logger.firestore.write(configPath, undefined, 'create');
      logger.debug('Process created successfully', { context: 'createProcess', data: { newProcessId } });

      // Set config change flag to notify agent (non-critical, agent polls anyway)
      try {
        const statusRef = doc(db, 'sites', siteId, 'machines', machineId);
        await updateDoc(statusRef, { configChangeFlag: true });
      } catch {
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
      timestamp: serverTimestamp(),
      status: 'pending',
      ...extraData,
    };

    await setDoc(commandRef, {
      [commandId]: commandData
    }, { merge: true });
  };

  const rebootMachine = async (machineId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    // Pre-compute the TARGET reboot time as Unix seconds (now + 30s, matching
    // the agent's `shutdown /r /t 30` in _handle_reboot_machine). Writing a
    // plain number — not serverTimestamp() — means the dashboard pill renders
    // the countdown the moment the listener fires, with no second round trip.
    //
    // configChangeFlag is REQUIRED by firestore.rules for any dashboard write
    // to the machine status doc. Without it the rule rejects the write
    // silently, which is why the previous version of this code never made
    // the optimistic countdown appear — the dashboard write was rejected.
    const targetReboot = Math.floor(Date.now() / 1000) + 30;
    await Promise.all([
      sendMachineCommand(machineId, 'reboot_machine'),
      updateDoc(machineRef, {
        rebootScheduledAt: targetReboot,
        configChangeFlag: true,
      }),
    ]);
  };

  const shutdownMachine = async (machineId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    // Same pattern as rebootMachine — pre-compute target time and include
    // configChangeFlag to satisfy firestore.rules.
    const targetShutdown = Math.floor(Date.now() / 1000) + 30;
    await Promise.all([
      sendMachineCommand(machineId, 'shutdown_machine'),
      updateDoc(machineRef, {
        shutdownScheduledAt: targetShutdown,
        configChangeFlag: true,
      }),
    ]);
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

  /**
   * Save a reboot schedule for a machine.
   *
   * Writes to `config/{siteId}/machines/{machineId}.rebootSchedule` with merge.
   * The agent's existing config listener picks this up and propagates to local
   * config.json, where the reboot state machine reads it. This means the schedule
   * survives Firestore disconnections — the agent fires from local cache.
   *
   * No `configChangeFlag` is needed because the rule for the config doc allows
   * any user with site access to write directly. (Contrast: writes to the
   * machine status doc require configChangeFlag.)
   */
  const updateRebootSchedule = async (machineId: string, schedule: RebootSchedule) => {
    if (!db) throw new Error('Firebase not configured');
    const configRef = doc(db, 'config', siteId, 'machines', machineId);
    await setDoc(configRef, { rebootSchedule: schedule }, { merge: true });
  };

  // Join each machine with its hardware/profile doc (if any) and produce the
  // derived `devices` field. Legacy (pre-v2) machines are shimmed first so
  // downstream code always sees the v2 layout. Memoized on the raw inputs so
  // we don't re-derive on unrelated re-renders.
  const joinedMachines = useMemo(() => {
    return machines.map((m) => {
      const profile = profiles[m.machineId];
      const withProfile = profile ? { ...m, profile } : m;
      const shimmed = shimLegacyMachine(withProfile);
      return joinMachineDevices(shimmed);
    });
  }, [machines, profiles]);

  return { machines: joinedMachines, loading, error, killProcess, setLaunchMode, updateProcess, deleteProcess, createProcess, rebootMachine, shutdownMachine, cancelReboot, dismissRebootPending, captureScreenshot, startLiveView, stopLiveView, updateRebootSchedule };
}
