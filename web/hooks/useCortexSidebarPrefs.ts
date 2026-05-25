'use client';

/**
 * Per-device persistence for the Cortex sidebar's expand/collapse state:
 *  - `sidebarOpen` — the whole sidebar panel open/collapsed
 *  - `collapsedGroups` — which category sections are collapsed
 *
 * Stored on the existing per-device prefs doc (`users/{uid}/devicePrefs/global`,
 * the same doc `useDevicePrefs` uses) under `cortexSidebarOpen` /
 * `cortexCollapsedGroups`. Hydrated once on mount, then local state is the
 * source of truth and writes are debounced. The setters mirror `useState`
 * (accept a value or an updater) so they're drop-in replacements.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';

const DEBOUNCE_MS = 400;

type SetState<T> = (value: T | ((prev: T) => T)) => void;

export interface CortexSidebarPrefs {
  sidebarOpen: boolean;
  setSidebarOpen: SetState<boolean>;
  collapsedGroups: Set<string>;
  setCollapsedGroups: SetState<Set<string>>;
}

export function useCortexSidebarPrefs(): CortexSidebarPrefs {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [sidebarOpen, setSidebarOpenState] = useState(true);
  const [collapsedGroups, setCollapsedGroupsState] = useState<Set<string>>(new Set());

  // Mirror refs let the setters read current state without being re-created.
  // Updated in effects (writing refs during render is disallowed).
  const sidebarOpenRef = useRef(sidebarOpen);
  const collapsedRef = useRef(collapsedGroups);
  const uidRef = useRef<string | null>(uid);
  useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);
  useEffect(() => { collapsedRef.current = collapsedGroups; }, [collapsedGroups]);
  useEffect(() => { uidRef.current = uid; }, [uid]);

  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const currentUid = uidRef.current;
    const updates = pendingRef.current;
    pendingRef.current = {};
    if (!db || !currentUid || Object.keys(updates).length === 0) return;
    setDoc(doc(db, 'users', currentUid, 'devicePrefs', 'global'), updates, { merge: true }).catch(
      (err) => console.error('Failed to persist cortex sidebar prefs:', err),
    );
  }, []);

  const schedulePersist = useCallback(
    (patch: Record<string, unknown>) => {
      if (!db || !uidRef.current) return;
      Object.assign(pendingRef.current, patch);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  // Hydrate once from Firestore. setState lives in the async callback (not the
  // synchronous effect body), so it doesn't trip the cascading-render lint rule.
  useEffect(() => {
    if (!db || !uid) return;
    let cancelled = false;
    getDoc(doc(db, 'users', uid, 'devicePrefs', 'global'))
      .then((snap) => {
        if (cancelled || !snap.exists()) return;
        const data = snap.data() as {
          cortexSidebarOpen?: unknown;
          cortexCollapsedGroups?: unknown;
        };
        if (typeof data.cortexSidebarOpen === 'boolean') {
          setSidebarOpenState(data.cortexSidebarOpen);
        }
        if (Array.isArray(data.cortexCollapsedGroups)) {
          setCollapsedGroupsState(new Set(data.cortexCollapsedGroups as string[]));
        }
      })
      .catch((err) => console.error('Failed to read cortex sidebar prefs:', err));
    return () => {
      cancelled = true;
    };
  }, [uid]);

  // Flush any pending write on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        flush();
      }
    };
  }, [flush]);

  const setSidebarOpen = useCallback<SetState<boolean>>(
    (value) => {
      const next = typeof value === 'function'
        ? (value as (p: boolean) => boolean)(sidebarOpenRef.current)
        : value;
      sidebarOpenRef.current = next;
      setSidebarOpenState(next);
      schedulePersist({ cortexSidebarOpen: next });
    },
    [schedulePersist],
  );

  const setCollapsedGroups = useCallback<SetState<Set<string>>>(
    (value) => {
      const next = typeof value === 'function'
        ? (value as (p: Set<string>) => Set<string>)(collapsedRef.current)
        : value;
      collapsedRef.current = next;
      setCollapsedGroupsState(next);
      schedulePersist({ cortexCollapsedGroups: Array.from(next) });
    },
    [schedulePersist],
  );

  return { sidebarOpen, setSidebarOpen, collapsedGroups, setCollapsedGroups };
}
