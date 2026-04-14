'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteField,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';

export type DeviceKind = 'cpu' | 'disk' | 'gpu' | 'nic';

export interface DeviceSelection {
  cpu?: string;
  disk?: string;
  gpu?: string;
  nic?: string;
}

export interface DevicePrefs {
  listView: DeviceSelection;
  cardView: Record<string, DeviceSelection>;
}

export interface UseDevicePrefsResult {
  prefs: DevicePrefs;
  loading: boolean;
  setListPref: (kind: DeviceKind, id: string | null) => void;
  setCardPref: (machineId: string, kind: DeviceKind, id: string | null) => void;
}

const DEFAULT_PREFS: DevicePrefs = { listView: {}, cardView: {} };
const DEBOUNCE_MS = 300;

const noop = (): void => {};

export function useDevicePrefs(): UseDevicePrefsResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [prefs, setPrefs] = useState<DevicePrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState<boolean>(true);

  // Buffers pending field-path writes until the debounce timer fires.
  // Value `null` means "delete this path" (serialized as deleteField()).
  const pendingRef = useRef<Map<string, string | null>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uidRef = useRef<string | null>(uid);

  useEffect(() => {
    uidRef.current = uid;
  }, [uid]);

  useEffect(() => {
    if (!db || !uid) return;

    const ref = doc(db, 'users', uid, 'devicePrefs', 'global');
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Partial<DevicePrefs>;
          setPrefs({
            listView: data.listView ?? {},
            cardView: data.cardView ?? {},
          });
        } else {
          setPrefs(DEFAULT_PREFS);
        }
        setLoading(false);
      },
      (err) => {
        console.error('Error subscribing to device prefs:', err);
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
      // Reset to defaults so a new sign-in doesn't briefly show the prior user's prefs.
      setPrefs(DEFAULT_PREFS);
      setLoading(true);
    };
  }, [uid]);

  const flush = useCallback(async (): Promise<void> => {
    const currentUid = uidRef.current;
    if (!db || !currentUid) {
      pendingRef.current.clear();
      return;
    }
    const pending = pendingRef.current;
    if (pending.size === 0) return;

    const ref = doc(db, 'users', currentUid, 'devicePrefs', 'global');
    const updates: Record<string, unknown> = {};
    for (const [path, value] of pending.entries()) {
      updates[path] = value === null ? deleteField() : value;
    }
    pending.clear();

    try {
      // updateDoc interprets dotted keys as nested field paths and supports
      // deleteField() sentinels. Ensure the doc exists first — updateDoc
      // rejects on missing docs, and setDoc({merge:true}) treats dotted keys
      // as literal field names rather than paths.
      await setDoc(ref, {}, { merge: true });
      await updateDoc(ref, updates);
    } catch (err) {
      console.error('Error writing device prefs:', err);
    }
  }, []);

  const schedule = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  const setListPref = useCallback((kind: DeviceKind, id: string | null): void => {
    if (!uidRef.current) return;
    // Optimistic local update so UI reflects selection immediately.
    setPrefs((prev) => {
      const next: DeviceSelection = { ...prev.listView };
      if (id === null) delete next[kind];
      else next[kind] = id;
      return { ...prev, listView: next };
    });
    pendingRef.current.set(`listView.${kind}`, id);
    schedule();
  }, [schedule]);

  const setCardPref = useCallback((machineId: string, kind: DeviceKind, id: string | null): void => {
    if (!uidRef.current) return;
    setPrefs((prev) => {
      const nextCard = { ...prev.cardView };
      const entry: DeviceSelection = { ...(nextCard[machineId] ?? {}) };
      if (id === null) delete entry[kind];
      else entry[kind] = id;
      nextCard[machineId] = entry;
      return { ...prev, cardView: nextCard };
    });
    pendingRef.current.set(`cardView.${machineId}.${kind}`, id);
    schedule();
  }, [schedule]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // Fire-and-forget final flush so in-flight edits aren't lost on unmount.
        void flush();
      }
    };
  }, [flush]);

  if (!uid) {
    return {
      prefs: DEFAULT_PREFS,
      loading: false,
      setListPref: noop,
      setCardPref: noop,
    };
  }

  return { prefs, loading, setListPref, setCardPref };
}
