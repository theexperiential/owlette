'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import type { RestartScheduleEntry } from '@/hooks/useFirestore';
import { BUILT_IN_RESTART_PRESETS } from '@/lib/restartDefaults';

/** Deterministic ID for a built-in preset. */
function builtInId(name: string): string {
  return `builtin-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Stable empty array so useMemo deps don't churn while no site is loaded. */
const EMPTY_RESTART_PRESETS: RestartPreset[] = [];

export interface RestartPreset {
  id: string;
  name: string;
  description?: string;
  /** Active on apply. Optional: presets predating this field omit it. */
  enabled?: boolean;
  entries: RestartScheduleEntry[];
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  /** null for built-in presets that have no Firestore override (never persisted). */
  createdAt: Timestamp | null;
  updatedAt?: Timestamp;
}

export interface UseRestartPresetsReturn {
  presets: RestartPreset[];
  loading: boolean;
  error: string | null;
  createPreset: (preset: Omit<RestartPreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updatePreset: (id: string, updates: Partial<RestartPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

/**
 * Per-site restart schedule presets. Built-ins are merged client-side from
 * BUILT_IN_RESTART_PRESETS; an edited built-in is saved to Firestore and its
 * override wins on the next read. Mirrors useSchedulePresets.
 *
 * The `reboot` spelling in `config/{siteId}/reboot_presets` and
 * `/api/sites/{siteId}/presets/reboot` is DELIBERATE — wire/storage contracts
 * shared with deployed agents and the public API. Only UI and code identifiers
 * were renamed to "restart"; renaming these needs a coordinated migration.
 */
export function useRestartPresets(siteId: string | null): UseRestartPresetsReturn {
  // loadedSiteId pins presets to their site so `loading` derives at render
  // instead of needing a sync setState in the effect body.
  const [state, setState] = useState<{
    firestorePresets: RestartPreset[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    firestorePresets: [],
    loadedSiteId: null,
    error: null,
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const presetsRef = collection(db, 'config', siteId, 'reboot_presets');

    const unsubscribe = onSnapshot(
      presetsRef,
      (snapshot) => {
        const data: RestartPreset[] = [];
        snapshot.forEach((docSnap) => {
          data.push({ id: docSnap.id, ...docSnap.data() } as RestartPreset);
        });
        setState({ firestorePresets: data, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching restart presets:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  // Only data for the currently-requested site.
  const firestorePresets = state.loadedSiteId === siteId ? state.firestorePresets : EMPTY_RESTART_PRESETS;
  const loading = !!db && !!siteId && state.loadedSiteId !== siteId;
  const error = state.error;

  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    const builtIns: RestartPreset[] = BUILT_IN_RESTART_PRESETS.map((bp, i) => {
      const id = builtInId(bp.name);
      const override = firestoreById.get(id);
      if (override) return override;
      return {
        id,
        name: bp.name,
        description: bp.description,
        enabled: bp.enabled,
        entries: bp.entries,
        isBuiltIn: true,
        order: i,
        createdBy: '',
        createdAt: null,
      };
    });

    const builtInIds = new Set(BUILT_IN_RESTART_PRESETS.map(bp => builtInId(bp.name)));
    const custom = firestorePresets
      .filter(p => !builtInIds.has(p.id))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });

    return [...builtIns, ...custom];
  }, [firestorePresets]);

  const createPreset = useCallback(async (
    preset: Omit<RestartPreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/reboot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preset),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create restart preset'));

    const body = await response.json();
    return body.presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<RestartPreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/reboot/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to update restart preset'));
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/reboot/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete restart preset'));
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
