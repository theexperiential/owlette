'use client';

/**
 * Live display profile + admin-assigned layout for one machine, exposed together so
 * callers can diff them (drift detection).
 *   live:     sites/{siteId}/machines/{machineId}/hardware/display
 *   assigned: config/{siteId}/machines/{machineId} (field: displays.assigned)
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import { canonicalizeMonitors } from '@/lib/displayCanonical';

export interface MonitorInfo {
  id: string;
  edidHash: string;
  manufacturerId: string;
  productCode: string;
  serialNumber: string;
  friendlyName: string;
  position: { x: number; y: number };
  resolution: { width: number; height: number };
  refreshHz: number;
  rotation: number; // 0, 90, 180, 270
  scalePct: number;
  primary: boolean;
  connectionType: string; // dp, hdmi, dvi, vga, internal
  adapterLuid: string;
  targetId: number;
}

export interface MosaicGridMember {
  displayId: number;
  row: number;
  col: number;
}

export interface MosaicGrid {
  rows: number;
  cols: number;
  compositeWidth: number;
  compositeHeight: number;
  members: MosaicGridMember[];
}

export interface DisplayProfile {
  schemaVersion: number;
  signatureHash: string;
  capturedAt: number;
  monitors: MonitorInfo[];
  mosaicActive: boolean;
  mosaicGrids?: MosaicGrid[];
}

export interface AssignedLayout {
  monitors: MonitorInfo[];
  capturedAt: number;
  capturedBy?: string;
}

export interface DisplayAutoRestoreCircuitBreaker {
  tripped: boolean;
  failures: number;
  trippedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface DisplayAutoRestoreState {
  enabled: boolean;
  enabledBy?: string;
  enabledAt?: number;
  circuitBreaker: DisplayAutoRestoreCircuitBreaker;
}

const DEFAULT_AUTO_RESTORE: DisplayAutoRestoreState = {
  enabled: false,
  circuitBreaker: { tripped: false, failures: 0 },
};

/**
 * `capturedAt` → epoch ms. Accepts Firestore Timestamps, the serialized
 * `{ seconds, nanoseconds }` shape (SSR/hydration/fixtures), and plain numbers.
 * Unrecognized input collapses to 0, which formatters render as "never".
 */
function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const asObj = value as { toMillis?: () => number; seconds?: unknown };
    if (typeof asObj.toMillis === 'function') {
      try {
        return asObj.toMillis();
      } catch {
        return 0;
      }
    }
    if (typeof asObj.seconds === 'number') {
      return asObj.seconds * 1000;
    }
  }
  return 0;
}

interface UseDisplayStateResult {
  profile: DisplayProfile | null;
  assigned: AssignedLayout | null;
  autoRestore: DisplayAutoRestoreState;
  /**
   * Agent kill switch (`displays.remoteApplyEnabled`); only literal `true` enables
   * remote apply. The "test" self-check button shows only while it is off, so
   * operators can verify the helper IPC before flipping it on.
   */
  remoteApplyEnabled: boolean;
  loading: boolean;
  error: string | null;
}

export interface UseDisplayStateOptions {
  /**
   * False skips both subscriptions and returns an inert result — lets a dashboard of
   * many cards open listeners only for expanded ones. Defaults true; true -> false
   * tears down via the effect cleanup.
   */
  enabled?: boolean;
  /**
   * False keeps the live-profile sub but skips the assigned-layout (config) sub, for
   * consumers that read drift from the heartbeat-published `displayDriftCount`.
   * Defaults true.
   */
  subscribeAssigned?: boolean;
}

/**
 * Hook state, tagged with its target so subscription callbacks can drop late snapshots
 * from a previous target instead of the effect resetting state synchronously (cascading renders).
 */
interface InternalState {
  siteId: string;
  machineId: string;
  profile: DisplayProfile | null;
  assigned: AssignedLayout | null;
  autoRestore: DisplayAutoRestoreState;
  remoteApplyEnabled: boolean;
  profileLoaded: boolean;
  assignedLoaded: boolean;
  error: string | null;
}

/**
 * Parse `displays.autoRestore`. Partial data is normal: the agent writes only timestamps
 * and counters, the dashboard writes enabled/enabledBy/enabledAt, and a fresh machine has
 * neither. Timestamps run through `normalizeTimestamp` — server writes are Firestore
 * Timestamps, agent REST writes are epoch numbers or iso8601.
 */
function parseAutoRestore(raw: unknown): DisplayAutoRestoreState {
  if (!raw || typeof raw !== 'object') return DEFAULT_AUTO_RESTORE;
  const r = raw as Record<string, unknown>;
  const cbRaw = (r.circuitBreaker && typeof r.circuitBreaker === 'object'
    ? r.circuitBreaker
    : {}) as Record<string, unknown>;

  const trippedAt = normalizeTimestamp(cbRaw.trippedAt);
  const lastSuccessAt = normalizeTimestamp(cbRaw.lastSuccessAt);
  const lastFailureAt = normalizeTimestamp(cbRaw.lastFailureAt);
  const enabledAt = normalizeTimestamp(r.enabledAt);

  const circuitBreaker: DisplayAutoRestoreCircuitBreaker = {
    tripped: typeof cbRaw.tripped === 'boolean' ? cbRaw.tripped : false,
    failures: typeof cbRaw.failures === 'number' ? cbRaw.failures : 0,
    ...(trippedAt > 0 ? { trippedAt } : {}),
    ...(lastSuccessAt > 0 ? { lastSuccessAt } : {}),
    ...(lastFailureAt > 0 ? { lastFailureAt } : {}),
    ...(typeof cbRaw.lastError === 'string' ? { lastError: cbRaw.lastError } : {}),
  };

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : false,
    ...(typeof r.enabledBy === 'string' ? { enabledBy: r.enabledBy } : {}),
    ...(enabledAt > 0 ? { enabledAt } : {}),
    circuitBreaker,
  };
}

/** drift-label → extractor; strict equality on the extracted primitive means no drift. */
const DRIFT_FIELDS: ReadonlyArray<{
  label: string;
  extract: (m: MonitorInfo) => unknown;
}> = [
  { label: 'position.x', extract: (m) => m.position?.x },
  { label: 'position.y', extract: (m) => m.position?.y },
  { label: 'resolution.width', extract: (m) => m.resolution?.width },
  { label: 'resolution.height', extract: (m) => m.resolution?.height },
  { label: 'refreshHz', extract: (m) => m.refreshHz },
  { label: 'rotation', extract: (m) => m.rotation },
  { label: 'scalePct', extract: (m) => m.scalePct },
  { label: 'primary', extract: (m) => m.primary },
];

/**
 * Translate monitor positions so the primary sits at (0, 0). Windows pins the primary to
 * the virtual-desktop origin, so a non-canonical layout gets silently re-anchored on apply
 * and the stored coordinates diverge from what the operator saw. Enforced at draft seed
 * (heals bad stored data) and at capture (never write non-canonical to Firestore).
 * No-op without a primary or when already at (0, 0); returns a new array.
 */
export function normalizePrimaryToOrigin(monitors: MonitorInfo[]): MonitorInfo[] {
  const primary = monitors.find((m) => m.primary);
  if (!primary) return monitors;
  const dx = primary.position.x;
  const dy = primary.position.y;
  if (dx === 0 && dy === 0) return monitors;
  return monitors.map((m) => ({
    ...m,
    position: { x: m.position.x - dx, y: m.position.y - dy },
  }));
}

/**
 * Live-vs-assigned comparison result.
 * `byLiveId` / `byAssignedId` are the same per-field drift keyed two ways: live ids come
 * from the agent's adapter-LUID/target-id pair, assigned ids are stored and can differ
 * after a reconnect even for the same physical panel.
 * `addedHashes` / `removedHashes` carry topology change, which the drift maps cannot —
 * an unmatched monitor lands in neither, so a disconnect used to read as zero drift.
 */
export interface DisplayDriftReport {
  byLiveId: Map<string, string[]>;
  byAssignedId: Map<string, string[]>;
  addedHashes: Set<string>;
  removedHashes: Set<string>;
}

/** Per-field drifts + added/removed monitors. Counts `byLiveId` only — the two maps
 * describe the same deltas, so summing both would double-count. */
export function totalDriftCount(report: DisplayDriftReport): number {
  return report.byLiveId.size + report.addedHashes.size + report.removedHashes.size;
}

/**
 * Full drift report: per-monitor field drifts keyed by live id and assigned id, plus
 * added/removed edidHashes. Matching is on `edidHash` (physical identity) so connector
 * reshuffles aren't drift; unmatched monitors only appear in the added/removed sets, so
 * callers must include those in any count or badge.
 */
export function computeDisplayDrift(
  live: MonitorInfo[],
  assigned: MonitorInfo[]
): DisplayDriftReport {
  const empty: DisplayDriftReport = {
    byLiveId: new Map<string, string[]>(),
    byAssignedId: new Map<string, string[]>(),
    addedHashes: new Set<string>(),
    removedHashes: new Set<string>(),
  };

  if (!live || !assigned) return empty;
  // No assigned layout stored = nothing to drift against.
  if (assigned.length === 0) return empty;

  const byLiveId = new Map<string, string[]>();
  const byAssignedId = new Map<string, string[]>();
  const addedHashes = new Set<string>();
  const removedHashes = new Set<string>();

  const assignedByHash = new Map<string, MonitorInfo>();
  for (const m of assigned) {
    if (m.edidHash) assignedByHash.set(m.edidHash, m);
  }

  const liveHashes = new Set<string>();
  for (const liveMonitor of live) {
    if (!liveMonitor.edidHash) continue;
    liveHashes.add(liveMonitor.edidHash);
    const assignedMonitor = assignedByHash.get(liveMonitor.edidHash);
    if (!assignedMonitor) {
      addedHashes.add(liveMonitor.edidHash);
      continue;
    }

    const drifted: string[] = [];
    for (const { label, extract } of DRIFT_FIELDS) {
      if (extract(liveMonitor) !== extract(assignedMonitor)) {
        drifted.push(label);
      }
    }

    if (drifted.length > 0) {
      byLiveId.set(liveMonitor.id, drifted);
      byAssignedId.set(assignedMonitor.id, drifted);
    }
  }

  for (const m of assigned) {
    if (m.edidHash && !liveHashes.has(m.edidHash)) {
      removedHashes.add(m.edidHash);
    }
  }

  return { byLiveId, byAssignedId, addedHashes, removedHashes };
}

export function useDisplayState(
  siteId: string,
  machineId: string,
  options?: UseDisplayStateOptions
): UseDisplayStateResult {
  const enabled = options?.enabled ?? true;
  const subscribeAssigned = options?.subscribeAssigned ?? true;
  const demo = useDemoContext();

  // Tagged with its target so async snapshot callbacks can discard results for a prior
  // (siteId, machineId) without a synchronous setState on target change.
  const [state, setState] = useState<InternalState>(() => ({
    siteId: '',
    machineId: '',
    profile: null,
    assigned: null,
    autoRestore: DEFAULT_AUTO_RESTORE,
    remoteApplyEnabled: false,
    profileLoaded: false,
    assignedLoaded: false,
    error: null,
  }));

  useEffect(() => {
    if (!db || !siteId || !machineId || !enabled || demo) {
      // Nothing to subscribe to; the render path handles these cases (demo included)
      // without mutating state. On enabled true -> false the previous run's cleanup has
      // already torn the subs down.
      return;
    }

    const profileRef = doc(db, 'sites', siteId, 'machines', machineId, 'hardware', 'display');

    // Monotonic counters stop a late async canonicalisation from overwriting state
    // written by a newer snapshot.
    let profileSeq = 0;
    let assignedSeq = 0;
    let cancelled = false;

    const unsubscribeProfile = onSnapshot(
      profileRef,
      (snap) => {
        const seq = ++profileSeq;
        const raw = snap.exists() ? (snap.data() as DisplayProfile) : null;
        void (async () => {
          let next: DisplayProfile | null = null;
          if (raw) {
            try {
              const canonical = await canonicalizeMonitors(raw.monitors || []);
              next = { ...raw, monitors: canonical };
            } catch (e) {
              // Web Crypto missing / malformed field: fall back to raw monitors, else
              // profileLoaded never flips and the panel is stuck on "loading".
              console.error('canonicalizeMonitors (profile) failed:', e);
              next = raw;
            }
          }
          if (cancelled || seq !== profileSeq) return;
          setState((prev) => {
            const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
            return {
              siteId,
              machineId,
              profile: next,
              assigned: sameTarget ? prev.assigned : null,
              autoRestore: sameTarget ? prev.autoRestore : DEFAULT_AUTO_RESTORE,
              remoteApplyEnabled: sameTarget ? prev.remoteApplyEnabled : false,
              profileLoaded: true,
              assignedLoaded: sameTarget ? prev.assignedLoaded : false,
              error: sameTarget ? prev.error : null,
            };
          });
        })();
      },
      (err) => {
        // Bump seq so an in-flight canonicalisation from the previous snapshot can't
        // overwrite this error state.
        const seq = ++profileSeq;
        console.error('Error subscribing to display profile:', err);
        if (cancelled || seq !== profileSeq) return;
        setState((prev) => {
          const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
          return {
            siteId,
            machineId,
            profile: sameTarget ? prev.profile : null,
            assigned: sameTarget ? prev.assigned : null,
            autoRestore: sameTarget ? prev.autoRestore : DEFAULT_AUTO_RESTORE,
            remoteApplyEnabled: sameTarget ? prev.remoteApplyEnabled : false,
            profileLoaded: true,
            assignedLoaded: sameTarget ? prev.assignedLoaded : false,
            error: err.message,
          };
        });
      }
    );

    // Opt-out sub: `subscribeAssigned: false` callers read drift from the heartbeat's
    // `metrics.displayDriftCount`. When skipped, the render path treats `assignedLoaded`
    // as satisfied so loading checks don't hang on a sub that never arrives.
    let unsubscribeAssigned: (() => void) | undefined;
    if (subscribeAssigned) {
      const configRef = doc(db, 'config', siteId, 'machines', machineId);
      unsubscribeAssigned = onSnapshot(
        configRef,
        (snap) => {
          const seq = ++assignedSeq;
          let rawMonitors: MonitorInfo[] | null = null;
          let capturedAt = 0;
          let capturedBy: string | undefined;
          let nextAutoRestore: DisplayAutoRestoreState = DEFAULT_AUTO_RESTORE;
          let nextRemoteApplyEnabled = false;
          if (snap.exists()) {
            const data = snap.data();
            const candidate = data?.displays?.assigned;
            if (candidate && Array.isArray(candidate.monitors)) {
              rawMonitors = candidate.monitors as MonitorInfo[];
              capturedAt = normalizeTimestamp(candidate.capturedAt);
              capturedBy = typeof candidate.capturedBy === 'string' ? candidate.capturedBy : undefined;
            }
            nextAutoRestore = parseAutoRestore(data?.displays?.autoRestore);
            // Fail closed: only literal `true` enables remote apply, so a truthy
            // non-boolean on a fresh agent doc can't opt in by accident.
            nextRemoteApplyEnabled = data?.displays?.remoteApplyEnabled === true;
          }
          void (async () => {
            let next: AssignedLayout | null = null;
            if (rawMonitors) {
              try {
                const canonical = await canonicalizeMonitors(rawMonitors);
                next = {
                  monitors: canonical,
                  capturedAt,
                  ...(capturedBy !== undefined ? { capturedBy } : {}),
                };
              } catch (e) {
                // Same fallback as the live-profile path: raw monitors beat stuck loading.
                console.error('canonicalizeMonitors (assigned) failed:', e);
                next = {
                  monitors: rawMonitors,
                  capturedAt,
                  ...(capturedBy !== undefined ? { capturedBy } : {}),
                };
              }
            }
            if (cancelled || seq !== assignedSeq) return;
            setState((prev) => {
              const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
              return {
                siteId,
                machineId,
                profile: sameTarget ? prev.profile : null,
                assigned: next,
                autoRestore: nextAutoRestore,
                remoteApplyEnabled: nextRemoteApplyEnabled,
                profileLoaded: sameTarget ? prev.profileLoaded : false,
                assignedLoaded: true,
                error: sameTarget ? prev.error : null,
              };
            });
          })();
        },
        (err) => {
          // Bump seq: a late success from the previous snapshot would otherwise resolve
          // after this error setState and revert to a stale ok state.
          const seq = ++assignedSeq;
          console.error('Error subscribing to assigned display layout:', err);
          if (cancelled || seq !== assignedSeq) return;
          setState((prev) => {
            const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
            return {
              siteId,
              machineId,
              profile: sameTarget ? prev.profile : null,
              assigned: sameTarget ? prev.assigned : null,
              autoRestore: sameTarget ? prev.autoRestore : DEFAULT_AUTO_RESTORE,
              remoteApplyEnabled: sameTarget ? prev.remoteApplyEnabled : false,
              profileLoaded: sameTarget ? prev.profileLoaded : false,
              assignedLoaded: true,
              error: err.message,
            };
          });
        }
      );
    }

    return () => {
      cancelled = true;
      unsubscribeProfile();
      if (unsubscribeAssigned) unsubscribeAssigned();
    };
  }, [siteId, machineId, enabled, subscribeAssigned, demo]);

  // Derived during render so the effect never has to synchronously reset state.

  // Demo: synthesized topology, no Firestore — the demo docs don't exist and would
  // surface a permission error. `remoteApplyEnabled: true` so visitors land on the
  // restore workflow instead of the one-time enable gate.
  if (demo) {
    if (!enabled || !machineId) {
      return { profile: null, assigned: null, autoRestore: DEFAULT_AUTO_RESTORE, remoteApplyEnabled: true, loading: false, error: null };
    }
    const { profile, assigned } = demo.getDisplayState(machineId);
    return {
      profile,
      assigned: subscribeAssigned ? assigned : null,
      autoRestore: DEFAULT_AUTO_RESTORE,
      remoteApplyEnabled: true,
      loading: false,
      error: null,
    };
  }

  if (!db) {
    return {
      profile: null,
      assigned: null,
      autoRestore: DEFAULT_AUTO_RESTORE,
      remoteApplyEnabled: false,
      loading: false,
      error: 'Firebase not configured',
    };
  }

  if (!enabled) {
    // Opted out of live subscriptions; prior subs are torn down by the effect cleanup.
    return {
      profile: null,
      assigned: null,
      autoRestore: DEFAULT_AUTO_RESTORE,
      remoteApplyEnabled: false,
      loading: false,
      error: null,
    };
  }

  if (!siteId || !machineId) {
    return {
      profile: null,
      assigned: null,
      autoRestore: DEFAULT_AUTO_RESTORE,
      remoteApplyEnabled: false,
      loading: false,
      error: null,
    };
  }

  // New target, no first snapshot yet: report loading with empty data so callers never
  // see the previous machine's values.
  if (state.siteId !== siteId || state.machineId !== machineId) {
    return {
      profile: null,
      assigned: null,
      autoRestore: DEFAULT_AUTO_RESTORE,
      remoteApplyEnabled: false,
      loading: true,
      error: null,
    };
  }

  return {
    profile: state.profile,
    // Opt-out callers never see an assigned layout; the effect skips that sub.
    assigned: subscribeAssigned ? state.assigned : null,
    // autoRestore shares the config doc with `assigned`, so opt-out callers have no live
    // source — safe default keeps consumers null-check free.
    autoRestore: subscribeAssigned ? state.autoRestore : DEFAULT_AUTO_RESTORE,
    // Same config doc: opt-out callers get off, so apply/test buttons stay hidden.
    remoteApplyEnabled: subscribeAssigned ? state.remoteApplyEnabled : false,
    // subscribeAssigned false ⇒ assignedLoaded is implicitly satisfied.
    loading: !state.profileLoaded || (subscribeAssigned && !state.assignedLoaded),
    error: state.error,
  };
}
