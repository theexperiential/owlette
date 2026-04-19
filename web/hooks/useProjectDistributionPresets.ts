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
import { BUILT_IN_PROJECT_DISTRIBUTION_PRESETS } from '@/lib/projectDistributionDefaults';

/** Deterministic ID for a built-in preset */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Strip undefined values from an object. Firestore rejects `undefined` field
 * values with "Unsupported field value: undefined". Optional preset fields
 * (extract_path, verify_files) come through as undefined when the user leaves
 * them blank, so we drop them before writing rather than storing nulls.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export interface ProjectDistributionPreset {
  id: string;
  name: string;
  description?: string;
  /**
   * Optional saved URL. Useful for projects redistributed periodically (e.g.
   * a Dropbox link that stays the same across deployments). Distribution
   * name is intentionally NOT carried — names tend to be per-deployment
   * (e.g. "Summer Show 2024").
   */
  project_url?: string;
  extract_path?: string;
  verify_files?: string[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface UseProjectDistributionPresetsReturn {
  presets: ProjectDistributionPreset[];
  loading: boolean;
  error: string | null;
  createPreset: (
    preset: Omit<ProjectDistributionPreset, 'id' | 'createdAt' | 'updatedAt'>
  ) => Promise<string>;
  updatePreset: (id: string, updates: Partial<ProjectDistributionPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

/**
 * Hook to manage project distribution presets scoped to a site.
 * Firestore path: config/{siteId}/project_distribution_presets/{presetId}
 *
 * Built-in presets are always present (merged client-side from
 * BUILT_IN_PROJECT_DISTRIBUTION_PRESETS). If an admin edits a built-in, the
 * override is saved to Firestore under the same `builtin-*` ID and takes
 * precedence over the hardcoded default.
 */
export function useProjectDistributionPresets(
  siteId: string | null
): UseProjectDistributionPresetsReturn {
  const [firestorePresets, setFirestorePresets] = useState<ProjectDistributionPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Mirrors useSchedulePresets / useRebootPresets — set-state-in-effect is
    // the established pattern across all preset hooks for handling the
    // Firebase-not-ready and params-not-ready gates. Diverging here would
    // make preset behavior inconsistent across the app.
    if (!db) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    if (!siteId) {
      // Params not ready — stay in loading until the site resolves. Flipping
      // to loading=false here would cause the dialog to briefly render
      // built-in defaults as if Firestore overrides didn't exist.
      setLoading(true);
      setFirestorePresets([]);
      return;
    }

    setLoading(true);

    try {
      const presetsRef = collection(db, 'config', siteId, 'project_distribution_presets');

      const unsubscribe = onSnapshot(
        presetsRef,
        (snapshot) => {
          const data: ProjectDistributionPreset[] = [];
          snapshot.forEach((docSnap) => {
            data.push({ id: docSnap.id, ...docSnap.data() } as ProjectDistributionPreset);
          });
          setFirestorePresets(data);
          setLoading(false);
          setError(null);
        },
        (err) => {
          console.error('Error fetching project distribution presets:', err);
          setError(err.message);
          setLoading(false);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setLoading(false);
    }
  }, [siteId]);

  // Merge built-in defaults with Firestore overrides + custom presets
  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    // Built-ins: use Firestore override if it exists, otherwise the hardcoded default
    const builtIns: ProjectDistributionPreset[] = BUILT_IN_PROJECT_DISTRIBUTION_PRESETS.map(
      (bp, i) => {
        const id = builtInId(bp.name);
        const override = firestoreById.get(id);
        if (override) return override;
        return {
          id,
          name: bp.name,
          description: bp.description,
          project_url: bp.project_url,
          extract_path: bp.extract_path,
          verify_files: bp.verify_files,
          isBuiltIn: true,
          order: i,
          createdBy: '',
          createdAt: null as unknown as Timestamp,
        };
      }
    );

    // Custom presets: everything in Firestore that isn't a built-in override
    const builtInIds = new Set(
      BUILT_IN_PROJECT_DISTRIBUTION_PRESETS.map(bp => builtInId(bp.name))
    );
    const custom = firestorePresets
      .filter(p => !builtInIds.has(p.id))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });

    return [...builtIns, ...custom];
  }, [firestorePresets]);

  const createPreset = useCallback(async (
    preset: Omit<ProjectDistributionPreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetId = `projdist-${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
    const presetRef = doc(db, 'config', siteId, 'project_distribution_presets', presetId);

    await setDoc(presetRef, {
      ...stripUndefined(preset),
      createdAt: serverTimestamp(),
    });

    return presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<ProjectDistributionPreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'project_distribution_presets', id);
    const cleanUpdates = stripUndefined(updates);

    if (id.startsWith('builtin-')) {
      // Built-in: use setDoc with merge so it creates the override doc on first edit
      await setDoc(presetRef, {
        ...cleanUpdates,
        isBuiltIn: true,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } else {
      await updateDoc(presetRef, {
        ...cleanUpdates,
        updatedAt: serverTimestamp(),
      });
    }
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const presetRef = doc(db, 'config', siteId, 'project_distribution_presets', id);
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
