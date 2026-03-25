/**
 * useSystemPresets Hook
 *
 * Manages global system presets for software deployment (Owlette Agent, TouchDesigner, etc.)
 * Admin-only write access, all authenticated users can read.
 *
 * Pattern: Mirrors useDeployments.ts structure for consistency (DRY principle)
 */

import { useState, useEffect } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';

export interface SystemPreset {
  id: string;
  name: string;                    // Display name: "TouchDesigner 2025.31550"
  software_name: string;           // Software identifier: "TouchDesigner"
  category: string;                // "Media Server" | "Creative Software" | "System" | "Utilities"
  description?: string;            // Optional long description
  icon?: string;                   // Emoji or icon identifier ("🎨", "🦉")
  installer_name: string;          // Filename: "TouchDesigner.exe"
  installer_url: string;           // Download URL (empty for Owlette - fetched dynamically)
  silent_flags: string;            // Installation flags
  verify_path?: string;            // Optional verification path
  close_processes?: string[];      // Process exe names to close before install
  is_owlette_agent: boolean;       // Special flag: fetches latest from installer_metadata
  timeout_seconds?: number;        // Optional custom timeout (default 600)
  order: number;                   // Display order in UI
  createdAt: Timestamp;
  createdBy: string;               // Admin user ID
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

/**
 * Hook to manage system presets
 *
 * @returns System presets management interface
 *
 * @example
 * const { presets, loading, createPreset } = useSystemPresets();
 *
 * // Create new preset
 * await createPreset({
 *   name: "TouchDesigner 2025.31550",
 *   software_name: "TouchDesigner",
 *   category: "Creative Software",
 *   icon: "🎨",
 *   installer_name: "TouchDesigner.exe",
 *   installer_url: "https://...",
 *   silent_flags: "/VERYSILENT /NORESTART",
 *   is_owlette_agent: false,
 *   order: 2,
 *   createdBy: userId
 * });
 */
export function useSystemPresets(): UseSystemPresetsReturn {
  const [presets, setPresets] = useState<SystemPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Real-time listener for system presets
  useEffect(() => {
    if (!db) {
      setLoading(false);
      setError('Firebase not configured');
      return;
    }

    try {
      const presetsRef = collection(db, 'system_presets');

      const unsubscribe = onSnapshot(
        presetsRef,
        (snapshot) => {
          const data: SystemPreset[] = [];
          snapshot.forEach((doc) => {
            data.push({ id: doc.id, ...doc.data() } as SystemPreset);
          });

          // Sort by order, then by name
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
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }, []);

  /**
   * Create a new system preset (admin only)
   */
  const createPreset = async (
    preset: Omit<SystemPreset, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    // Generate preset ID from software_name
    const presetId = `preset-${preset.software_name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const presetRef = doc(db, 'system_presets', presetId);

    await setDoc(presetRef, {
      ...preset,
      createdAt: serverTimestamp(),
    });

    return presetId;
  };

  /**
   * Update an existing system preset (admin only)
   */
  const updatePreset = async (
    id: string,
    updates: Partial<SystemPreset>
  ): Promise<void> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    const presetRef = doc(db, 'system_presets', id);

    await updateDoc(presetRef, {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  };

  /**
   * Delete a system preset (admin only)
   */
  const deletePreset = async (id: string): Promise<void> => {
    if (!db) {
      throw new Error('Firebase not configured');
    }

    const presetRef = doc(db, 'system_presets', id);
    await deleteDoc(presetRef);
  };

  /**
   * Get preset by ID
   */
  const getPresetById = (id: string): SystemPreset | undefined => {
    return presets.find(p => p.id === id);
  };

  /**
   * Get presets by category
   */
  const getPresetsByCategory = (category: string): SystemPreset[] => {
    return presets.filter(p => p.category === category);
  };

  /**
   * Get unique categories from all presets
   */
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
