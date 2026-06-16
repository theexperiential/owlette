'use client';

/**
 * useDisplayEventFeed Hook
 *
 * Subscribes to display-related events for a single machine, sourced from
 * `sites/{siteId}/logs` (the agent stamps each log doc with a `machineId`
 * field; see `agent/src/firebase_client.py` `log_event`). Returns the most
 * recent events newest-first, updated in real time.
 */

import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';

export interface DisplayEventEntry {
  id: string;
  action: string;
  level: string;
  details: string;
  machineId: string;
  machineName: string;
  timestamp: number;
}

export interface UseDisplayEventFeedResult {
  events: DisplayEventEntry[];
  loading: boolean;
  error: string | null;
}

export interface UseDisplayEventFeedOptions {
  enabled?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const EMPTY_EVENTS: DisplayEventEntry[] = [];

/**
 * Every `display_*` action the agent emits — via `_emit_display_event`
 * (agent/src/owlette_service.py) and the display audit / apply paths
 * (agent/src/display_manager.py). SINGLE SOURCE OF TRUTH for "what is a display
 * event" on the web side: the events feed filters on this set server-side.
 *
 * IMPORTANT: when the agent adds a new `display_*` action, add it here too —
 * otherwise that event type silently never appears in the panel. Firestore caps
 * an `in` filter at 30 values; keep this list under that (currently 15).
 */
export const DISPLAY_EVENT_ACTIONS = [
  'display_monitor_added',
  'display_monitor_removed',
  'display_monitor_swapped',
  'display_drift',
  'display_mosaic_disabled',
  'display_sync_lost',
  'display_apply_succeeded',
  'display_apply_failed',
  'display_apply_refused_mosaic',
  'display_apply_acked',
  'display_auto_revert_fired',
  'display_revert_deferred',
  'display_auto_restore_fired',
  'display_auto_restore_skipped_unfixable',
  'display_auto_restore_circuit_breaker_tripped',
] as const;

/**
 * Normalize a Firestore timestamp value into epoch milliseconds. Mirrors the
 * helper in `useDisplayState` so the two hooks treat the same wire shapes
 * identically (Timestamp instance, plain `{seconds, nanoseconds}` from SSR /
 * test fixtures, raw number, or anything unrecognized -> 0).
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

interface InternalState {
  siteId: string;
  machineId: string;
  events: DisplayEventEntry[];
  loaded: boolean;
  error: string | null;
}

export function useDisplayEventFeed(
  siteId: string,
  machineId: string,
  options?: UseDisplayEventFeedOptions,
): UseDisplayEventFeedResult {
  const enabled = options?.enabled ?? true;
  const requestedLimit = options?.limit ?? DEFAULT_LIMIT;
  const demo = useDemoContext();

  // State is tagged with the (siteId, machineId) it belongs to so async
  // snapshot callbacks can discard results for a prior target without the
  // effect having to call setState synchronously on mount/target-change.
  const [state, setState] = useState<InternalState>(() => ({
    siteId: '',
    machineId: '',
    events: EMPTY_EVENTS,
    loaded: false,
    error: null,
  }));

  useEffect(() => {
    if (!db || !siteId || !machineId || !enabled || demo) {
      // Render path handles these cases (demo, disabled, missing target)
      // without a state mutation here. Cleanup from the prior effect run
      // tears down any live subscription before this no-op body executes.
      return;
    }

    // Fetch this machine's display events newest-first, filtered to the known
    // display action set SERVER-SIDE. Filtering by action (rather than
    // over-fetching all logs and filtering `display_*` on the client) means a
    // burst of unrelated logs — process crashes, commands, deploys — can never
    // push recent display events out of the limit window. The orderBy is
    // essential: without it Firestore returns docs in document-ID order, and log
    // IDs are random UUIDs (see firebase_client.log_event), so the limit would
    // slice a time-agnostic subset. Backed by the (action ASC, machineId ASC,
    // timestamp DESC) composite index in firestore.indexes.json.
    const logsRef = collection(db, 'sites', siteId, 'logs');
    const q = query(
      logsRef,
      where('machineId', '==', machineId),
      where('action', 'in', [...DISPLAY_EVENT_ACTIONS]),
      orderBy('timestamp', 'desc'),
      limit(requestedLimit),
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const next: DisplayEventEntry[] = [];
        const candidates = snap.docs
          .map((docSnap) => {
            const data = docSnap.data() as Record<string, unknown>;
            return { docSnap, data, timestamp: normalizeTimestamp(data.timestamp) };
          })
          .sort((a, b) => b.timestamp - a.timestamp);

        // The query already restricts to DISPLAY_EVENT_ACTIONS and caps at
        // requestedLimit, so every candidate is a display event — just map them.
        for (const { docSnap, data, timestamp } of candidates) {
          const action = typeof data.action === 'string' ? data.action : '';
          next.push({
            id: docSnap.id,
            action,
            level: typeof data.level === 'string' ? data.level : 'info',
            details: typeof data.details === 'string' ? data.details : '',
            machineId: typeof data.machineId === 'string' ? data.machineId : machineId,
            machineName: typeof data.machineName === 'string' ? data.machineName : '',
            timestamp,
          });
        }
        setState({
          siteId,
          machineId,
          events: next,
          loaded: true,
          error: null,
        });
      },
      (err) => {
        console.error('Error subscribing to display event feed:', err);
        setState({
          siteId,
          machineId,
          events: EMPTY_EVENTS,
          loaded: true,
          error: 'events unavailable',
        });
      },
    );

    return () => {
      unsubscribe();
    };
  }, [siteId, machineId, enabled, requestedLimit, demo]);

  // Demo route — synthesized display events aren't part of the demo dataset
  // yet, so return inert. Skip the live Firestore path entirely; the demo
  // site/machine docs don't exist and would surface a permission error.
  if (demo) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  if (!db) {
    return { events: EMPTY_EVENTS, loading: false, error: 'Firebase not configured' };
  }

  if (!enabled) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  if (!siteId || !machineId) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  // Props changed but the subscription hasn't produced its first snapshot
  // for the new target yet — report loading with empty events so callers
  // never see stale values from the previous machine.
  if (state.siteId !== siteId || state.machineId !== machineId) {
    return { events: EMPTY_EVENTS, loading: true, error: null };
  }

  return {
    events: state.events,
    loading: !state.loaded,
    error: state.error,
  };
}
