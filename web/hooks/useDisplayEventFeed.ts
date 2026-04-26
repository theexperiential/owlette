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
/** Over-fetch multiplier — see effect body for why. */
const OVERFETCH_FACTOR = 4;
const EMPTY_EVENTS: DisplayEventEntry[] = [];

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

    // The composite (machineId ==, action prefix, timestamp desc) requires a
    // double orderBy on Firestore which forces a heavy composite index. We
    // instead query by (machineId ==) + (timestamp desc) and filter the
    // `display_*` prefix client-side. Logs per machine are bounded, and we
    // over-fetch by OVERFETCH_FACTOR so the filtered set still fills the
    // requested limit even when non-display events are interleaved.
    const logsRef = collection(db, 'sites', siteId, 'logs');
    const q = query(
      logsRef,
      where('machineId', '==', machineId),
      orderBy('timestamp', 'desc'),
      limit(requestedLimit * OVERFETCH_FACTOR),
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const next: DisplayEventEntry[] = [];
        for (const docSnap of snap.docs) {
          const data = docSnap.data() as Record<string, unknown>;
          const action = typeof data.action === 'string' ? data.action : '';
          if (!action.startsWith('display_')) continue;
          next.push({
            id: docSnap.id,
            action,
            level: typeof data.level === 'string' ? data.level : 'info',
            details: typeof data.details === 'string' ? data.details : '',
            machineId: typeof data.machineId === 'string' ? data.machineId : machineId,
            machineName: typeof data.machineName === 'string' ? data.machineName : '',
            timestamp: normalizeTimestamp(data.timestamp),
          });
          if (next.length >= requestedLimit) break;
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
          error: err.message,
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
