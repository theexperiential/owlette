'use client';

/**
 * Per-device persistence for one boolean UI preference, stored under `field` on
 * the shared `users/{uid}/devicePrefs/global` doc. Hydrated once on mount;
 * afterwards local state wins and writes are debounced.
 *
 * `ready` stays false until hydration settles so callers can avoid flashing the
 * default and snapping to the persisted value.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';

const DEBOUNCE_MS = 400;

export interface DevicePrefFlag {
  value: boolean;
  setValue: (next: boolean) => void;
  /** False until the stored value has been read (or determined absent). */
  ready: boolean;
}

export function useDevicePrefFlag(field: string, defaultValue: boolean): DevicePrefFlag {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [value, setValueState] = useState(defaultValue);
  const [ready, setReady] = useState(false);

  const uidRef = useRef<string | null>(uid);
  const fieldRef = useRef(field);
  useEffect(() => { uidRef.current = uid; }, [uid]);
  useEffect(() => { fieldRef.current = field; }, [field]);

  const pendingRef = useRef<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const currentUid = uidRef.current;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (!db || !currentUid || next === null) return;
    setDoc(doc(db, 'users', currentUid, 'devicePrefs', 'global'), { [fieldRef.current]: next }, { merge: true })
      .catch((err) => console.error(`Failed to persist device pref "${fieldRef.current}":`, err));
  }, []);

  // setState stays in the async callback, not the effect body, or the
  // cascading-render lint rule fires.
  useEffect(() => {
    if (!db || !uid) return;
    let cancelled = false;
    getDoc(doc(db, 'users', uid, 'devicePrefs', 'global'))
      .then((snap) => {
        if (cancelled) return;
        const stored = snap.exists() ? (snap.data() as Record<string, unknown>)[field] : undefined;
        if (typeof stored === 'boolean') setValueState(stored);
        setReady(true);
      })
      .catch((err) => {
        console.error(`Failed to read device pref "${field}":`, err);
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      // A different sign-in must re-hydrate before its value is trusted.
      setReady(false);
      setValueState(defaultValue);
    };
  }, [uid, field, defaultValue]);

  // Flush on unmount so a toggle right before navigation sticks.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        flush();
      }
    };
  }, [flush]);

  const setValue = useCallback(
    (next: boolean) => {
      setValueState(next);
      if (!db || !uidRef.current) return;
      pendingRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  // Signed out or no firestore: the default is already the final answer.
  return { value, setValue, ready: ready || !db || !uid };
}

export interface DevicePrefNumber {
  value: number;
  setValue: (next: number) => void;
  /** False until the stored value has been read (or determined absent). */
  ready: boolean;
}

/**
 * Numeric sibling of `useDevicePrefFlag` (same doc, debounce, hydration) for
 * size prefs. Clamped to [min, max] on hydrate AND set, so a stale or
 * hand-edited value can't render an unusable layout.
 */
export function useDevicePrefNumber(
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): DevicePrefNumber {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(min, Math.round(n))),
    [min, max],
  );

  const [value, setValueState] = useState(defaultValue);
  const [ready, setReady] = useState(false);

  const uidRef = useRef<string | null>(uid);
  const fieldRef = useRef(field);
  useEffect(() => { uidRef.current = uid; }, [uid]);
  useEffect(() => { fieldRef.current = field; }, [field]);

  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const currentUid = uidRef.current;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (!db || !currentUid || next === null) return;
    setDoc(doc(db, 'users', currentUid, 'devicePrefs', 'global'), { [fieldRef.current]: next }, { merge: true })
      .catch((err) => console.error(`Failed to persist device pref "${fieldRef.current}":`, err));
  }, []);

  useEffect(() => {
    if (!db || !uid) return;
    let cancelled = false;
    getDoc(doc(db, 'users', uid, 'devicePrefs', 'global'))
      .then((snap) => {
        if (cancelled) return;
        const stored = snap.exists() ? (snap.data() as Record<string, unknown>)[field] : undefined;
        if (typeof stored === 'number' && Number.isFinite(stored)) setValueState(clamp(stored));
        setReady(true);
      })
      .catch((err) => {
        console.error(`Failed to read device pref "${field}":`, err);
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      setReady(false);
      setValueState(defaultValue);
    };
  }, [uid, field, defaultValue, clamp]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        flush();
      }
    };
  }, [flush]);

  const setValue = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setValueState(clamped);
      if (!db || !uidRef.current) return;
      pendingRef.current = clamped;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush, clamp],
  );

  return { value, setValue, ready: ready || !db || !uid };
}
