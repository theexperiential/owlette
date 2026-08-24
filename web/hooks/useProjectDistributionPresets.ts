'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { BUILT_IN_PROJECT_DISTRIBUTION_PRESETS } from '@/lib/projectDistributionDefaults';

/** Deterministic ID for a built-in preset */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Firestore rejects `undefined` field values, and blank optional preset fields
 * arrive as undefined — drop them rather than storing nulls.
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
   * Saved URL for projects redistributed periodically. The distribution name is
   * deliberately not carried — names are per-deployment.
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
 * Site-scoped distribution presets at
 * `config/{siteId}/project_distribution_presets/{presetId}`.
 *
 * Built-ins are merged client-side from
 * BUILT_IN_PROJECT_DISTRIBUTION_PRESETS; editing one saves an override under
 * the same `builtin-*` id, which then wins over the hardcoded default.
 */
export function useProjectDistributionPresets(
  siteId: string | null
): UseProjectDistributionPresetsReturn {
  const [firestorePresets, setFirestorePresets] = useState<ProjectDistributionPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // set-state-in-effect matches every other preset hook's not-ready gates;
    // diverging here would make preset behavior inconsistent app-wide.
    if (!db) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    if (!siteId) {
      // Stay loading until the site resolves — loading=false here flashes the
      // built-in defaults as if no Firestore override existed.
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

  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    // Override if Firestore has one, else the hardcoded default.
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

    // Custom = everything in Firestore that isn't a built-in override.
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

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/distribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stripUndefined(preset)),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create distribution preset'));

    const body = await response.json();
    return body.presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<ProjectDistributionPreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const cleanUpdates = stripUndefined(updates);

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/distribution/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleanUpdates),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to update distribution preset'));
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/distribution/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete distribution preset'));
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

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
