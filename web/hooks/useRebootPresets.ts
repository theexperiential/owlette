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
import type { RebootScheduleEntry } from '@/hooks/useFirestore';
import { BUILT_IN_REBOOT_PRESETS } from '@/lib/rebootDefaults';

/** Deterministic ID for a built-in preset. */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export interface RebootPreset {
  id: string;
  name: string;
  description?: string;
  entries: RebootScheduleEntry[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface UseRebootPresetsReturn {
  presets: RebootPreset[];
  loading: boolean;
  error: string | null;
  createPreset: (preset: Omit<RebootPreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updatePreset: (id: string, updates: Partial<RebootPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

/**
 * Hook to manage reboot schedule presets scoped to a site.
 * Firestore path: config/{siteId}/reboot_presets/{presetId}
 *
 * Mirrors the pattern in useSchedulePresets — built-in presets are merged
 * client-side from BUILT_IN_REBOOT_PRESETS. If a user edits a built-in, the
 * override is saved to Firestore and takes precedence on next read.
 */
export function useRebootPresets(siteId: string | null): UseRebootPresetsReturn {
  const [firestorePresets, setFirestorePresets] = useState<RebootPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      return;
    }

    try {
      const presetsRef = collection(db, 'config', siteId, 'reboot_presets');

      const unsubscribe = onSnapshot(
        presetsRef,
        (snapshot) => {
          const data: RebootPreset[] = [];
          snapshot.forEach((docSnap) => {
            data.push({ id: docSnap.id, ...docSnap.data() } as RebootPreset);
          });
          setFirestorePresets(data);
          setLoading(false);
          setError(null);
        },
        (err) => {
          console.error('Error fetching reboot presets:', err);
          setError(err.message);
          setLoading(false);
        }
      );

      return () => unsubscribe();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }, [siteId]);

  // Merge built-in defaults with Firestore overrides + custom presets
  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    const builtIns: RebootPreset[] = BUILT_IN_REBOOT_PRESETS.map((bp, i) => {
      const id = builtInId(bp.name);
      const override = firestoreById.get(id);
      if (override) return override;
      return {
        id,
        name: bp.name,
        description: bp.description,
        entries: bp.entries,
        isBuiltIn: true,
        order: i,
        createdBy: '',
        createdAt: null as any,
      };
    });

    const builtInIds = new Set(BUILT_IN_REBOOT_PRESETS.map(bp => builtInId(bp.name)));
    const custom = firestorePresets
      .filter(p => !builtInIds.has(p.id))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });

    return [...builtIns, ...custom];
  }, [firestorePresets]);

  const createPreset = useCallback(async (
    preset: Omit<RebootPreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetId = `reboot-${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
    const presetRef = doc(db, 'config', siteId, 'reboot_presets', presetId);

    await setDoc(presetRef, {
      ...preset,
      createdAt: serverTimestamp(),
    });

    return presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<RebootPreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'reboot_presets', id);

    if (id.startsWith('builtin-')) {
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

    const presetRef = doc(db, 'config', siteId, 'reboot_presets', id);
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
