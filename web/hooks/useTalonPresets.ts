'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { BUILT_IN_TALON_PRESETS } from '@/lib/talons/templates';
import type { TalonPresetRequirement, TalonPresetTemplate } from '@/lib/talons/presetTemplate';

// A built-in's id is read from its definition (`builtin-<slug>`), never
// re-derived from its name here. Deriving it twice typechecks and agrees
// today, but the two spellings drift the moment a built-in is renamed — and
// the failure is silent: the override stops matching and quietly reappears as
// a *custom* preset alongside the built-in it was meant to replace.

/** Stable empty array so useMemo deps don't churn while no site is loaded. */
const EMPTY_TALON_PRESETS: StoredTalonPreset[] = [];

/** Stable empty array so a custom preset's `requires` never churns a dep list. */
const NO_REQUIREMENTS: readonly TalonPresetRequirement[] = [];

export interface TalonPreset {
  id: string;
  name: string;
  description?: string;
  /** The talon this preset seeds — no scope, no enabled, no process ids. */
  template: TalonPresetTemplate;
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  /** null for built-in presets that have no Firestore override (never persisted). */
  createdAt: Timestamp | null;
  updatedAt?: Timestamp;
  /**
   * What the operator still has to supply — derived from the shipped catalog,
   * NEVER stored. An override of a built-in inherits its requirements: editing
   * the copy cannot change what the template needs to run.
   */
  requires: readonly TalonPresetRequirement[];
}

/** What actually lives in Firestore — `requires` is computed on read. */
type StoredTalonPreset = Omit<TalonPreset, 'requires'>;

export interface UseTalonPresetsReturn {
  presets: TalonPreset[];
  loading: boolean;
  error: string | null;
  createPreset: (
    preset: Omit<TalonPreset, 'id' | 'createdAt' | 'updatedAt' | 'requires'>,
  ) => Promise<string>;
  updatePreset: (id: string, updates: Partial<StoredTalonPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
}

/**
 * Hook to manage talon presets ("templates") scoped to a site.
 * Firestore path: `config/{siteId}/talon_presets/{presetId}`.
 *
 * Storage sits under `config/` with the schedule, restart and distribution
 * families rather than beside the talons themselves, because this is the fourth
 * family that ships built-ins and needs their client-side merge — the
 * deployment-template family's `sites/{siteId}` root is legacy compatibility
 * with `useDeployments`, not a pattern to propagate.
 *
 * Read is a direct Firestore listener; every write goes through
 * `/api/sites/{siteId}/presets/talon` so the capability check, the validator
 * and the audit emit can't be sidestepped — firestore.rules allows client reads
 * only.
 *
 * Built-in presets are always present, merged client-side from
 * `BUILT_IN_TALON_PRESETS`. If an admin edits one, the override is saved at
 * `builtin-<slug>` and takes precedence on the next read. There is deliberately
 * no hide/archive flag: no preset family has one, and adding it here would make
 * talon presets the fifth divergent convention rather than the consistent
 * fourth.
 *
 * Pass `null` for `siteId` to keep the listener closed (the editor does this in
 * edit mode, where no picker renders).
 */
export function useTalonPresets(siteId: string | null): UseTalonPresetsReturn {
  // loadedSiteId pins the loaded presets to the site they came from so that
  // loading can be derived at render (no sync setState in the effect body).
  const [state, setState] = useState<{
    firestorePresets: StoredTalonPreset[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    firestorePresets: [],
    loadedSiteId: null,
    error: null,
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const presetsRef = collection(db, 'config', siteId, 'talon_presets');

    const unsubscribe = onSnapshot(
      presetsRef,
      (snapshot) => {
        const data: StoredTalonPreset[] = [];
        snapshot.forEach((docSnap) => {
          data.push({ id: docSnap.id, ...docSnap.data() } as StoredTalonPreset);
        });
        setState({ firestorePresets: data, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching talon presets:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  // Surface only data that matches the currently-requested site; derive loading.
  const firestorePresets =
    state.loadedSiteId === siteId ? state.firestorePresets : EMPTY_TALON_PRESETS;
  const loading = !!db && !!siteId && state.loadedSiteId !== siteId;
  const error = state.error;

  // Merge built-in defaults with Firestore overrides + custom presets
  const presets = useMemo(() => {
    const firestoreById = new Map(firestorePresets.map(p => [p.id, p]));

    // Built-ins: use the Firestore override if one exists, otherwise the
    // shipped default. Either way `requires` comes from the definition.
    const builtIns: TalonPreset[] = BUILT_IN_TALON_PRESETS.map((definition, i) => {
      const id = definition.id;
      const override = firestoreById.get(id);
      if (override) return { ...override, requires: definition.requires };
      return {
        id,
        name: definition.name,
        description: definition.description,
        template: definition.template,
        isBuiltIn: true,
        order: i,
        createdBy: '',
        createdAt: null,
        requires: definition.requires,
      };
    });

    // Custom presets: everything in Firestore that isn't a built-in override.
    const builtInIds = new Set(BUILT_IN_TALON_PRESETS.map(d => d.id));
    const custom: TalonPreset[] = firestorePresets
      .filter(p => !builtInIds.has(p.id))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      })
      .map(p => ({ ...p, requires: NO_REQUIREMENTS }));

    return [...builtIns, ...custom];
  }, [firestorePresets]);

  const createPreset = useCallback(async (
    preset: Omit<TalonPreset, 'id' | 'createdAt' | 'updatedAt' | 'requires'>
  ): Promise<string> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/talon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preset),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create talon preset'));

    const body = await response.json();
    return body.presetId;
  }, [siteId]);

  const updatePreset = useCallback(async (
    id: string,
    updates: Partial<StoredTalonPreset>
  ): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/talon/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to update talon preset'));
  }, [siteId]);

  const deletePreset = useCallback(async (id: string): Promise<void> => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/presets/talon/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete talon preset'));
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
