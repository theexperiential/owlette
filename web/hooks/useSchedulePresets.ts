'use client';

import { useState, useEffect, useCallback } from 'react';
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

export interface SchedulePreset {
  id: string;
  name: string;
  description?: string;
  blocks: ScheduleBlock[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface UseSchedulePresetsReturn {
  presets: SchedulePreset[];
  loading: boolean;
  error: string | null;
  createPreset: (preset: Omit<SchedulePreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updatePreset: (id: string, updates: Partial<SchedulePreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  seedBuiltInPresets: (userId: string) => Promise<void>;
}

/**
 * Hook to manage schedule presets scoped to a site.
 * Firestore path: config/{siteId}/schedule_presets/{presetId}
 */
export function useSchedulePresets(siteId: string | null): UseSchedulePresetsReturn {
  const [presets, setPresets] = useState<SchedulePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      return;
    }

    try {
      const presetsRef = collection(db, 'config', siteId, 'schedule_presets');

      const unsubscribe = onSnapshot(
        presetsRef,
        (snapshot) => {
          const data: SchedulePreset[] = [];
          snapshot.forEach((docSnap) => {
            data.push({ id: docSnap.id, ...docSnap.data() } as SchedulePreset);
          });

          data.sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return a.name.localeCompare(b.name);
          });

          setPresets(data);
          setLoading(false);
          setError(null);
        },
        (err) => {
          console.error('Error fetching schedule presets:', err);
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
    await updateDoc(presetRef, {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'schedule_presets', id);
    await deleteDoc(presetRef);
  }, [siteId]);

  /**
   * Seed built-in presets if the collection is empty.
   * Called once when admin first accesses schedule presets.
   */
  const seedBuiltInPresets = useCallback(async (userId: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    for (let i = 0; i < BUILT_IN_PRESETS.length; i++) {
      const bp = BUILT_IN_PRESETS[i];
      const presetId = `builtin-${bp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const presetRef = doc(db, 'config', siteId, 'schedule_presets', presetId);

      await setDoc(presetRef, {
        name: bp.name,
        description: bp.description,
        blocks: bp.blocks,
        isBuiltIn: true,
        order: i,
        createdBy: userId,
        createdAt: serverTimestamp(),
      });
    }
  }, [siteId]);

  return {
    presets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
    seedBuiltInPresets,
  };
}
