'use client';

/**
 * useDisplayState Hook
 *
 * Subscribes to the live display profile and the admin-assigned layout for a
 * single machine and exposes both via a single hook so callers can compare the
 * two (drift detection).
 *
 * Firestore paths:
 *   - Live profile:    sites/{siteId}/machines/{machineId}/hardware/display
 *   - Assigned layout: config/{siteId}/machines/{machineId} (field: displays.assigned)
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
 * Normalize a `capturedAt` value into epoch milliseconds.
 *
 * Firestore returns `serverTimestamp()` writes as Timestamp objects on read,
 * but serialized snapshots (SSR, hydration, test fixtures) can surface the
 * underlying `{ seconds, nanoseconds }` shape. Plain-number shapes are also
 * supported for forward compat with any future writer that stores `Date.now()`.
 * Anything unrecognized collapses to 0 so downstream formatters (which treat 0
 * as "never") behave predictably.
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
   * Wave 6.1 master kill switch on the agent (config field
   * `displays.remoteApplyEnabled`). `true` enables the remote apply path;
   * any other value (including missing) treats it as off. The dashboard
   * uses this to decide whether to surface the "test" apply self-check
   * button (visible only when the switch is off so operators can verify
   * the helper IPC before flipping it on).
   */
  remoteApplyEnabled: boolean;
  loading: boolean;
  error: string | null;
}

export interface UseDisplayStateOptions {
  /**
   * When false, skip both Firestore subscriptions and return an inert result
   * ({profile: null, assigned: null, loading: false, error: null}). Useful for
   * dashboards that render many machine cards where only expanded cards should
   * open listeners. Defaults to true. Transitions from true -> false correctly
   * tear down the live subscriptions via the effect's cleanup.
   */
  enabled?: boolean;
  /**
   * When false, skip the assigned-layout subscription (config doc) but keep
   * the live-profile subscription. Use this when the consumer only needs the
   * live monitor data (e.g. the dashboard card's collapsed monitor summary)
   * and reads drift state from the heartbeat-published `displayDriftCount`
   * instead. Defaults to true so existing call sites that need both keep
   * working unchanged.
   */
  subscribeAssigned?: boolean;
}

/**
 * Internal snapshot of everything the hook is tracking, tagged with the
 * target it belongs to. Tagging the state lets the subscription callbacks
 * ignore late snapshots from a previous target without the effect having to
 * reset state synchronously (which would trigger cascading renders).
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
 * Parse the `displays.autoRestore` subobject from the config doc into the
 * typed shape. Tolerates missing/partial data — agent writes only the fields
 * it owns (timestamps + counters), the dashboard writes `enabled`/`enabledBy`/
 * `enabledAt`, and the doc may carry neither on a fresh machine. Timestamp
 * fields go through `normalizeTimestamp` because they may be Firestore
 * Timestamps (server writes) or epoch numbers / iso8601 (agent REST writes).
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

/**
 * Fields compared between a live monitor and its assigned counterpart.
 * Each entry maps a drift-label to an extractor; strict equality on the
 * extracted primitive determines drift. Keeping this as a table (rather than
 * a wall of conditionals) keeps the semantics obvious and the function pure.
 */
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
 * Translate every monitor's position so the primary lands at (0, 0).
 *
 * Windows pins the primary monitor to the origin of the virtual desktop —
 * any layout we persist or preview must obey that invariant, otherwise the
 * OS will silently re-anchor on apply and the stored coordinates drift from
 * what the operator saw. We enforce it at two boundaries: draft seed (so
 * pre-existing bad data self-heals the first time a user enters edit mode)
 * and capture (so we never write non-canonical data to Firestore). A pure
 * helper means both call sites — plus the in-edit normalization in
 * `useDisplayDraft.updateMonitor` — share one implementation.
 *
 * No-op when there is no primary, or when the primary is already at (0, 0).
 * Returns a new array; input is not mutated.
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
 * Result of comparing a live display snapshot against an assigned layout.
 *
 * `byLiveId` and `byAssignedId` are the same per-field drift signal keyed
 * two different ways — live-id for the live tab's table and canvas
 * (identified by the agent's adapter-LUID/target-id pair), assigned-id for
 * the stored tab (assigned monitors carry their own ids that may differ
 * after a reconnect even when the physical panel is identical). Callers
 * pick the one that matches what they're rendering.
 *
 * `addedHashes` and `removedHashes` carry the "layout changed" signal the
 * per-field drift maps can't express: a monitor with no match on the other
 * side never makes it into either map. Without these, disconnecting a
 * monitor registered as zero drift even though the topology clearly changed.
 */
export interface DisplayDriftReport {
  byLiveId: Map<string, string[]>;
  byAssignedId: Map<string, string[]>;
  addedHashes: Set<string>;
  removedHashes: Set<string>;
}

/**
 * Total number of changes worth surfacing to the operator — per-field
 * drifts plus added/removed monitors. Counting drifts from `byLiveId` only
 * (not byAssignedId) avoids double-counting since the two maps describe
 * the same physical deltas under different keys.
 */
export function totalDriftCount(report: DisplayDriftReport): number {
  return report.byLiveId.size + report.addedHashes.size + report.removedHashes.size;
}

/**
 * Compare live monitors against an assigned layout and return the full
 * drift report: per-monitor field drifts (keyed both by live id and by
 * assigned id) plus the sets of added / removed edidHashes.
 *
 * Matching is keyed on `edidHash` (physical identity) so connector
 * reshuffles don't register as drift. Monitors present in `live` but
 * missing from `assigned` (or vice versa) land in `addedHashes` /
 * `removedHashes` — callers should factor those into any drift count or
 * badge so a disconnected or newly-plugged monitor doesn't silently show
 * as "no changes".
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
  // With no assigned layout stored, there's nothing to drift against —
  // matches the previous contract's "no assigned = no drift" behavior.
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

  // State is tagged with the target it belongs to so the async snapshot
  // callbacks can discard results for a prior (siteId, machineId) without the
  // effect having to call setState synchronously on mount/target-change.
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
      // Nothing to subscribe to. The render path below handles these cases
      // (including demo mode, which short-circuits with synthesized state)
      // without needing us to mutate state here. When `enabled` flips from
      // true -> false, the cleanup returned by the previous effect run tears
      // down the live subscriptions before this no-op body executes.
      return;
    }

    const profileRef = doc(db, 'sites', siteId, 'machines', machineId, 'hardware', 'display');

    // Monotonic snapshot counters guard against late async canonicalisation
    // resolving after a newer snapshot has already updated state. SHA-1 of
    // a handful of monitors is sub-millisecond in practice, but tearing
    // down the effect or receiving a burst of snapshots could otherwise let
    // an older result overwrite a newer one.
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
              // Web Crypto unavailable / malformed monitor field — fall back
              // to the raw (uncanonicalised) monitors so the panel still
              // renders. Without this, a digest failure would leave
              // profileLoaded false forever and the panel stuck on "loading".
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
        // Bump the seq so a still-in-flight success-path canonicalisation
        // from the previous snapshot can't slip past us and overwrite the
        // error state. Same `cancelled` guard for teardown.
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

    // Assigned-layout sub is opt-out: callers that only need the live profile
    // (e.g. the dashboard card's collapsed monitor summary) skip it via
    // `subscribeAssigned: false` and read drift state from the heartbeat-
    // published `metrics.displayDriftCount` instead. When skipped, the render
    // path below treats `assignedLoaded` as implicitly satisfied so consumers'
    // loading checks don't hang waiting on a sub that will never arrive.
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
            // Wave 6.1 master kill switch — only literal `true` enables the
            // remote apply path. Anything else (false / missing / non-bool)
            // collapses to off so a fresh agent doc can't accidentally opt
            // in by having the field default to a truthy non-boolean.
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
                // Same fallback rationale as the live-profile path: render
                // raw monitors rather than getting stuck loading.
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
          // Bump seq to invalidate any in-flight success-path canonicalisation
          // from the previous snapshot — without this, a late success could
          // resolve after this error setState and revert us to a stale ok state.
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

  // Derive the return value during render so the effect never has to
  // synchronously reset state.

  // Demo route — return synthesized topology directly. Skip the live
  // Firestore path entirely; the demo site/machine docs don't exist and
  // would surface a permission error in the panel's loading state.
  // Demo machines start with `remoteApplyEnabled: true` so the panel
  // surfaces the "restore" workflow rather than the one-time "enable
  // restore" gate — visitors should land on the meaningful demo state.
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
    // Caller has opted out of live subscriptions (e.g. a collapsed card on a
    // dashboard with many machines). Return an inert result; any prior
    // subscriptions are torn down by the effect's cleanup.
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

  // Props changed but subscriptions haven't produced their first snapshot yet
  // for the new target — report loading with empty data so callers never see
  // stale values from the previous machine.
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
    // Opt-out callers never see an assigned layout; the effect skips the sub.
    assigned: subscribeAssigned ? state.assigned : null,
    // autoRestore lives on the same config doc as `assigned`, so when the
    // assigned sub is opted out we have no live source for it — fall back to
    // the safe default so consumers can still read flags without null-checks.
    autoRestore: subscribeAssigned ? state.autoRestore : DEFAULT_AUTO_RESTORE,
    // remoteApplyEnabled lives on the same config doc — opt-out callers see
    // the safe default (off) so the apply / test buttons stay hidden.
    remoteApplyEnabled: subscribeAssigned ? state.remoteApplyEnabled : false,
    // When subscribeAssigned is false, treat assignedLoaded as implicitly
    // satisfied so `loading` flips as soon as the profile sub lands.
    loading: !state.profileLoaded || (subscribeAssigned && !state.assignedLoaded),
    error: state.error,
  };
}
