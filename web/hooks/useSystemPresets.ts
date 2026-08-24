/**
 * Global system presets for software deployment (Owlette Agent, TouchDesigner, …).
 * Admin-only writes; all authenticated users read. Mirrors useDeployments.ts.
 */

import { useState, useEffect } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  Timestamp
} from 'firebase/firestore';

export interface SystemPreset {
  id: string;
  name: string;                    // e.g. "TouchDesigner 2025.31550"
  software_name: string;           // e.g. "TouchDesigner"
  category: string;                // "Media Server" | "Creative Software" | "System" | "Utilities"
  description?: string;
  icon?: string;                   // emoji
  installer_name: string;
  installer_url: string;           // empty for Owlette — fetched dynamically
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];      // exe names to close before install
  parallel_install?: boolean;      // install alongside existing versions (hides registry keys)
  sha256_checksum?: string;        // 64-char hex; agents refuse installs without one
  is_owlette_agent: boolean;       // fetches latest from installer_metadata
  timeout_seconds?: number;        // default 600
  order: number;                   // display order
  createdAt: Timestamp;
  createdBy: string;               // admin uid
  updatedAt?: Timestamp;
}

export interface UseSystemPresetsReturn {
  presets: SystemPreset[];
  loading: boolean;
  error: string | null;
  createPreset: (preset: Omit<SystemPreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updatePreset: (id: string, updates: Partial<SystemPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  getPresetById: (id: string) => SystemPreset | undefined;
  getPresetsByCategory: (category: string) => SystemPreset[];
  categories: string[];
}

export function useSystemPresets(): UseSystemPresetsReturn {
  const [presets, setPresets] = useState<SystemPreset[]>([]);
  const [loading, setLoading] = useState(!!db);
  const [error, setError] = useState<string | null>(db ? null : 'Firebase not configured');

  useEffect(() => {
    if (!db) return;

    // No try/catch: `collection()` only throws on invalid path segments (a literal here) and
    // onSnapshot routes runtime errors to its error callback. A sync catch-block setState would
    // violate react-hooks/set-state-in-effect.
    const presetsRef = collection(db, 'system_presets');

    const unsubscribe = onSnapshot(
      presetsRef,
      (snapshot) => {
        const data: SystemPreset[] = [];
        snapshot.forEach((doc) => {
          data.push({ id: doc.id, ...doc.data() } as SystemPreset);
        });

        data.sort((a, b) => {
          if (a.order !== b.order) {
            return a.order - b.order;
          }
          return a.name.localeCompare(b.name);
        });

        setPresets(data);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Error fetching system presets:', err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  /** admin only */
  const createPreset = async (
    preset: Omit<SystemPreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    const response = await fetch('/api/platform/system-presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preset),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create system preset'));

    const body = await response.json();
    return body.presetId;
  };

  /** admin only */
  const updatePreset = async (
    id: string,
    updates: Partial<SystemPreset>
  ): Promise<void> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    const response = await fetch(`/api/platform/system-presets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to update system preset'));
  };

  /** admin only */
  const deletePreset = async (id: string): Promise<void> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    const response = await fetch(`/api/platform/system-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete system preset'));
  };

  const getPresetById = (id: string): SystemPreset | undefined => {
    return presets.find(p => p.id === id);
  };

  const getPresetsByCategory = (category: string): SystemPreset[] => {
    return presets.filter(p => p.category === category);
  };

  const categories = Array.from(new Set(presets.map(p => p.category))).sort();

  return {
    presets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
    getPresetById,
    getPresetsByCategory,
    categories,
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
