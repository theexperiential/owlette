'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import { BUILT_IN_PRESETS } from '@/lib/scheduleDefaults';

/** Deterministic ID for a built-in preset */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Stable empty array so useMemo deps don't churn while no site is loaded. */
const EMPTY_SCHEDULE_PRESETS: SchedulePreset[] = [];

export interface SchedulePreset {
  id: string;
  name: string;
  description?: string;
  blocks: ScheduleBlock[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  /** null for built-in presets that have no Firestore override (never persisted). */
  createdAt: Timestamp | null;
  updatedAt?: Timestamp;
}

export interface UseSchedulePresetsReturn {
  presets: SchedulePreset[];
  loading: boolean;
  error: string | null;
  createPreset: (preset: Omit<SchedulePreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updatePreset: (id: string, updates: Partial<SchedulePreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

/**
 * Hook to manage schedule presets scoped to a site.
 * Firestore path: config/{siteId}/schedule_presets/{presetId}
 *
 * Built-in presets are always present (merged client-side from BUILT_IN_PRESETS).
 * If an admin edits a built-in, the override is saved to Firestore and takes precedence.
 */
export function useSchedulePresets(siteId: string | null): UseSchedulePresetsReturn {
  // loadedSiteId pins Firestore presets to the site they came from so that
  // `loading` can be derived at render (no sync setState in the effect body).
  // The original behavior — staying in loading while siteId is null so the
  // editor doesn't flash built-in defaults as if Firestore had no overrides —
  // is preserved: `loadedSiteId` is null until the first snapshot lands.
  const [state, setState] = useState<{
    firestorePresets: SchedulePreset[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    firestorePresets: [],
    loadedSiteId: null,
    error: null,
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const presetsRef = collection(db, 'config', siteId, 'schedule_presets');

    const unsubscribe = onSnapshot(
      presetsRef,
      (snapshot) => {
        const data: SchedulePreset[] = [];
        snapshot.forEach((docSnap) => {
          data.push({ id: docSnap.id, ...docSnap.data() } as SchedulePreset);
        });
        setState({ firestorePresets: data, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching schedule presets:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  // Surface only data that matches the currently-requested site. When siteId
  // is null, stay in loading — otherwise the editor briefly renders built-in
  // defaults as if no Firestore overrides existed (see original comment).
  const firestorePresets = state.loadedSiteId === siteId ? state.firestorePresets : EMPTY_SCHEDULE_PRESETS;
  const loading = !!db && (!siteId || state.loadedSiteId !== siteId);
  const error = state.error;

  // Merge built-in defaults with Firestore overrides + custom presets
  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    // Built-ins: use Firestore override if it exists, otherwise the hardcoded default
    const builtIns: SchedulePreset[] = BUILT_IN_PRESETS.map((bp, i) => {
      const id = builtInId(bp.name);
      const override = firestoreById.get(id);
      if (override) return override;
      return {
        id,
        name: bp.name,
        description: bp.description,
        blocks: bp.blocks,
        isBuiltIn: true,
        order: i,
        createdBy: '',
        createdAt: null,
      };
    });

    // Custom presets: everything in Firestore that isn't a built-in override
    const builtInIds = new Set(BUILT_IN_PRESETS.map(bp => builtInId(bp.name)));
    const custom = firestorePresets
      .filter(p => !builtInIds.has(p.id))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });

    return [...builtIns, ...custom];
  }, [firestorePresets]);

  const createPreset = useCallback(async (
    preset: Omit<SchedulePreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetId = `sched-${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
    const presetRef = doc(db, 'config', siteId, 'schedule_presets', presetId);

    await setDoc(presetRef, {
      ...preset,
      createdAt: serverTimestamp(),
    });

    return presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<SchedulePreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'schedule_presets', id);

    if (id.startsWith('builtin-')) {
      // Built-in: use setDoc with merge so it creates the override doc on first edit
      await setDoc(presetRef, {
        ...updates,
        isBuiltIn: true,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } else {
      await updateDoc(presetRef, {
        ...updates,
        updatedAt: serverTimestamp(),
      });
    }
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'schedule_presets', id);
    await deleteDoc(presetRef);
  }, [siteId]);

  return {
    presets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
  };
}
