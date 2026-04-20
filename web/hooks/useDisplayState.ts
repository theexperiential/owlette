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
  profileLoaded: boolean;
  assignedLoaded: boolean;
  error: string | null;
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
 * Compare live monitors against an assigned layout and return per-monitor drift.
 *
 * Matching is keyed on `edidHash` (physical identity) so connector reshuffles
 * don't register as drift. Monitors present in `live` but missing from
 * `assigned` (or vice versa) are not reported here — that's a higher-level
 * "layout changed" signal handled by the caller.
 *
 * @returns Map of `monitorId` (live monitor id) -> list of drifted field labels.
 */
export function computeDisplayDrift(
  live: MonitorInfo[],
  assigned: MonitorInfo[]
): Map<string, string[]> {
  const drift = new Map<string, string[]>();

  if (!live || !assigned || assigned.length === 0) {
    return drift;
  }

  const assignedByHash = new Map<string, MonitorInfo>();
  for (const m of assigned) {
    if (m.edidHash) {
      assignedByHash.set(m.edidHash, m);
    }
  }

  for (const liveMonitor of live) {
    if (!liveMonitor.edidHash) continue;
    const assignedMonitor = assignedByHash.get(liveMonitor.edidHash);
    if (!assignedMonitor) continue;

    const drifted: string[] = [];
    for (const { label, extract } of DRIFT_FIELDS) {
      if (extract(liveMonitor) !== extract(assignedMonitor)) {
        drifted.push(label);
      }
    }

    if (drifted.length > 0) {
      drift.set(liveMonitor.id, drifted);
    }
  }

  return drift;
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

    const unsubscribeProfile = onSnapshot(
      profileRef,
      (snap) => {
        const next = snap.exists() ? (snap.data() as DisplayProfile) : null;
        setState((prev) => {
          const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
          return {
            siteId,
            machineId,
            profile: next,
            assigned: sameTarget ? prev.assigned : null,
            profileLoaded: true,
            assignedLoaded: sameTarget ? prev.assignedLoaded : false,
            error: sameTarget ? prev.error : null,
          };
        });
      },
      (err) => {
        console.error('Error subscribing to display profile:', err);
        setState((prev) => {
          const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
          return {
            siteId,
            machineId,
            profile: sameTarget ? prev.profile : null,
            assigned: sameTarget ? prev.assigned : null,
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
    // published `metrics.displayDriftCount` instead. When skipped, we mark
    // assignedLoaded=true so consumers' loading checks don't hang waiting on
    // a sub that will never arrive.
    let unsubscribeAssigned: (() => void) | undefined;
    if (subscribeAssigned) {
      const configRef = doc(db, 'config', siteId, 'machines', machineId);
      unsubscribeAssigned = onSnapshot(
        configRef,
        (snap) => {
          let next: AssignedLayout | null = null;
          if (snap.exists()) {
            const data = snap.data();
            const candidate = data?.displays?.assigned;
            if (candidate && Array.isArray(candidate.monitors)) {
              next = {
                monitors: candidate.monitors as MonitorInfo[],
                capturedAt: normalizeTimestamp(candidate.capturedAt),
                capturedBy: typeof candidate.capturedBy === 'string' ? candidate.capturedBy : undefined,
              };
            }
          }
          setState((prev) => {
            const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
            return {
              siteId,
              machineId,
              profile: sameTarget ? prev.profile : null,
              assigned: next,
              profileLoaded: sameTarget ? prev.profileLoaded : false,
              assignedLoaded: true,
              error: sameTarget ? prev.error : null,
            };
          });
        },
        (err) => {
          console.error('Error subscribing to assigned display layout:', err);
          setState((prev) => {
            const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
            return {
              siteId,
              machineId,
              profile: sameTarget ? prev.profile : null,
              assigned: sameTarget ? prev.assigned : null,
              profileLoaded: sameTarget ? prev.profileLoaded : false,
              assignedLoaded: true,
              error: err.message,
            };
          });
        }
      );
    } else {
      setState((prev) => {
        const sameTarget = prev.siteId === siteId && prev.machineId === machineId;
        return {
          siteId,
          machineId,
          profile: sameTarget ? prev.profile : null,
          assigned: null,
          profileLoaded: sameTarget ? prev.profileLoaded : false,
          assignedLoaded: true,
          error: sameTarget ? prev.error : null,
        };
      });
    }

    return () => {
      unsubscribeProfile();
      if (unsubscribeAssigned) unsubscribeAssigned();
    };
  }, [siteId, machineId, enabled, subscribeAssigned, demo]);

  // Derive the return value during render so the effect never has to
  // synchronously reset state.

  // Demo route — return synthesized topology directly. Skip the live
  // Firestore path entirely; the demo site/machine docs don't exist and
  // would surface a permission error in the panel's loading state.
  if (demo) {
    if (!enabled || !machineId) {
      return { profile: null, assigned: null, loading: false, error: null };
    }
    const { profile, assigned } = demo.getDisplayState(machineId);
    return {
      profile,
      assigned: subscribeAssigned ? assigned : null,
      loading: false,
      error: null,
    };
  }

  if (!db) {
    return {
      profile: null,
      assigned: null,
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
      loading: false,
      error: null,
    };
  }

  if (!siteId || !machineId) {
    return {
      profile: null,
      assigned: null,
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
      loading: true,
      error: null,
    };
  }

  return {
    profile: state.profile,
    assigned: state.assigned,
    loading: !state.profileLoaded || !state.assignedLoaded,
    error: state.error,
  };
}
