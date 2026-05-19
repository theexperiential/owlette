'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useProjectDistributionPresets } from '@/hooks/useProjectDistributionPresets';
import { firestoreTsToMs, type FirestoreTs } from './useFirestore';

export interface ProjectDistributionTarget {
  machineId: string;
  status: 'pending' | 'downloading' | 'extracting' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  error?: string;
  completedAt?: FirestoreTs;
  cancelledAt?: FirestoreTs;
}

export interface ProjectDistribution {
  id: string;
  name: string;
  file_name: string;
  project_url: string;
  extract_path?: string;
  verify_files?: string[];
  targets: ProjectDistributionTarget[];
  createdAt: FirestoreTs;
  completedAt?: FirestoreTs;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial' | 'cancelled';
}

export function useProjectDistributions(siteId: string) {
  // loadedSiteId pins data to the site it was populated for so `loading` can be
  // derived at render. Status reconciliation is server-owned.
  const [state, setState] = useState<{
    distributions: ProjectDistribution[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    distributions: [],
    loadedSiteId: null,
    error: db ? null : 'Firebase not configured',
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const distributionsRef = collection(db, 'sites', siteId, 'project_distributions');

    const unsubscribe = onSnapshot(
      distributionsRef,
      (snapshot) => {
        const distributionData: ProjectDistribution[] = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          distributionData.push({
            id: doc.id,
            name: data.name || 'Unnamed Distribution',
            file_name: data.file_name || '',
            project_url: data.project_url || '',
            extract_path: data.extract_path,
            verify_files: data.verify_files,
            targets: data.targets || [],
            createdAt: data.createdAt || Date.now(),
            completedAt: data.completedAt,
            status: data.status || 'pending',
          });
        });

        distributionData.sort((a, b) => firestoreTsToMs(b.createdAt) - firestoreTsToMs(a.createdAt));

        setState({ distributions: distributionData, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching project distributions:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  const distributions = useMemo(
    () => (state.loadedSiteId === siteId ? state.distributions : []),
    [state.loadedSiteId, state.distributions, siteId],
  );
  const loading = !!db && !!siteId && state.loadedSiteId !== siteId;
  const error = state.error;

  const createDistribution = async (
    distribution: Omit<ProjectDistribution, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const body = {
      name: distribution.name,
      file_name: distribution.file_name,
      project_url: distribution.project_url,
      machines: machineIds,
      ...(distribution.extract_path ? { extract_path: distribution.extract_path } : {}),
      ...(distribution.verify_files?.length ? { verify_files: distribution.verify_files } : {}),
    };

    const response = await fetch(projectDistributionsUrl(siteId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey('project-dist-create'),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create project distribution'));

    const result = await response.json();
    return result.distributionId as string;
  };

  const cancelDistribution = async (distributionId: string, machineId: string, fileName: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    void machineId;
    void fileName;

    const response = await fetch(`${projectDistributionsUrl(siteId)}/${encodeURIComponent(distributionId)}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey(`project-dist-cancel-${distributionId}`),
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to cancel project distribution'));

    return `cancel-project-dist-${distributionId}`;
  };

  const deleteDistribution = async (distributionId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`${projectDistributionsUrl(siteId)}/${encodeURIComponent(distributionId)}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey(`project-dist-delete-${distributionId}`),
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete project distribution'));
  };

  return { distributions, loading, error, createDistribution, cancelDistribution, deleteDistribution };
}

// Convenience hook to get both presets and distributions
export function useProjectDistributionManager(siteId: string) {
  const presets = useProjectDistributionPresets(siteId);
  const distributions = useProjectDistributions(siteId);

  return {
    presets: presets.presets,
    presetsLoading: presets.loading,
    presetsError: presets.error,

    distributions: distributions.distributions,
    distributionsLoading: distributions.loading,
    distributionsError: distributions.error,
    createDistribution: distributions.createDistribution,
    cancelDistribution: distributions.cancelDistribution,
    deleteDistribution: distributions.deleteDistribution,
  };
}

function projectDistributionsUrl(siteId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/project-distributions`;
}

function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
