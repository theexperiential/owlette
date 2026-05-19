'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { firestoreTsToMs, type FirestoreTs } from './useFirestore';

export interface DeploymentTemplate {
  id: string;
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];
  parallel_install?: boolean;
  createdAt: FirestoreTs;
}

export interface DeploymentTarget {
  machineId: string;
  status: 'pending' | 'closing_processes' | 'downloading' | 'installing' | 'completed' | 'failed' | 'cancelled' | 'uninstalled';
  progress?: number;
  error?: string;
  completedAt?: FirestoreTs;
  cancelledAt?: FirestoreTs;
  uninstalledAt?: FirestoreTs;
}

export interface Deployment {
  id: string;
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];
  suppress_projects?: string[];
  parallel_install?: boolean;
  targets: DeploymentTarget[];
  createdAt: FirestoreTs;
  completedAt?: FirestoreTs;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial' | 'cancelled' | 'uninstalled';
}

export function useDeploymentTemplates(siteId: string) {
  // loadedSiteId pins state to the site it was populated for so `loading` can
  // be derived at render without forcing a synchronous reset on site changes.
  const [state, setState] = useState<{
    templates: DeploymentTemplate[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    templates: [],
    loadedSiteId: null,
    error: db ? null : 'Firebase not configured',
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const templatesRef = collection(db, 'sites', siteId, 'installer_templates');

    const unsubscribe = onSnapshot(
      templatesRef,
      (snapshot) => {
        const templateData: DeploymentTemplate[] = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          templateData.push({
            id: doc.id,
            name: data.name || 'Unnamed Template',
            installer_name: data.installer_name || '',
            installer_url: data.installer_url || '',
            silent_flags: data.silent_flags || '',
            verify_path: data.verify_path,
            close_processes: data.close_processes,
            parallel_install: data.parallel_install,
            createdAt: data.createdAt || Date.now(),
          });
        });

        templateData.sort((a, b) => firestoreTsToMs(b.createdAt) - firestoreTsToMs(a.createdAt));

        setState({ templates: templateData, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching templates:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  const templates = state.loadedSiteId === siteId ? state.templates : [];
  const loading = !!db && !!siteId && state.loadedSiteId !== siteId;
  const error = state.error;

  const createTemplate = async (template: Omit<DeploymentTemplate, 'id' | 'createdAt'>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(deploymentTemplateUrl(siteId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(template),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create deployment template'));

    const result = await response.json();
    return result.templateId as string;
  };

  const updateTemplate = async (templateId: string, template: Partial<Omit<DeploymentTemplate, 'id' | 'createdAt'>>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`${deploymentTemplateUrl(siteId)}/${encodeURIComponent(templateId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(template),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to update deployment template'));
  };

  const deleteTemplate = async (templateId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`${deploymentTemplateUrl(siteId)}/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete deployment template'));
  };

  return { templates, loading, error, createTemplate, updateTemplate, deleteTemplate };
}

export function useDeployments(siteId: string) {
  // Status reconciliation and command fan-out now live behind server APIs.
  // This hook keeps only the read-side subscription and calls API routes for
  // mutations.
  const [state, setState] = useState<{
    deployments: Deployment[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    deployments: [],
    loadedSiteId: null,
    error: db ? null : 'Firebase not configured',
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const deploymentsRef = collection(db, 'sites', siteId, 'deployments');

    const unsubscribe = onSnapshot(
      deploymentsRef,
      (snapshot) => {
        const deploymentData: Deployment[] = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          deploymentData.push({
            id: doc.id,
            name: data.name || 'Unnamed Deployment',
            installer_name: data.installer_name || '',
            installer_url: data.installer_url || '',
            silent_flags: data.silent_flags || '',
            verify_path: data.verify_path,
            close_processes: data.close_processes,
            suppress_projects: data.suppress_projects,
            parallel_install: data.parallel_install,
            targets: data.targets || [],
            createdAt: data.createdAt || Date.now(),
            completedAt: data.completedAt,
            status: data.status || 'pending',
          });
        });

        deploymentData.sort((a, b) => firestoreTsToMs(b.createdAt) - firestoreTsToMs(a.createdAt));

        setState({ deployments: deploymentData, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching deployments:', err);
        setState((prev) => ({ ...prev, error: err.message }));
      }
    );

    return () => unsubscribe();
  }, [siteId]);

  const deployments = useMemo(
    () => (state.loadedSiteId === siteId ? state.deployments : []),
    [state.loadedSiteId, state.deployments, siteId],
  );
  const loading = !!db && !!siteId && state.loadedSiteId !== siteId;
  const error = state.error;

  const createDeployment = async (
    deployment: Omit<Deployment, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const body = {
      name: deployment.name,
      installer_name: deployment.installer_name,
      installer_url: deployment.installer_url,
      silent_flags: deployment.silent_flags,
      machines: machineIds,
      ...(deployment.verify_path ? { verify_path: deployment.verify_path } : {}),
      ...(deployment.close_processes?.length ? { close_processes: deployment.close_processes } : {}),
      ...(deployment.suppress_projects?.length ? { suppress_projects: deployment.suppress_projects } : {}),
      ...(deployment.parallel_install ? { parallel_install: true } : {}),
    };

    const response = await fetch(deploymentsUrl(siteId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey('deployment-create'),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to create deployment'));

    const result = await response.json();
    return result.deploymentId as string;
  };

  const cancelDeployment = async (deploymentId: string, machineId: string, installer_name: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    void machineId;
    void installer_name;

    const response = await fetch(`${deploymentsUrl(siteId)}/${encodeURIComponent(deploymentId)}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey(`deployment-cancel-${deploymentId}`),
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to cancel deployment'));

    return `cancel-deployment-${deploymentId}`;
  };

  const deleteDeployment = async (deploymentId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await fetch(`${deploymentsUrl(siteId)}/${encodeURIComponent(deploymentId)}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': makeIdempotencyKey(`deployment-delete-${deploymentId}`),
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete deployment'));
  };

  const checkMachineHasActiveDeployment = (machineId: string): boolean => {
    return deployments.some(deployment => {
      if (deployment.status !== 'pending' && deployment.status !== 'in_progress') {
        return false;
      }

      return deployment.targets.some(target => {
        if (target.machineId !== machineId) return false;

        return target.status === 'pending' ||
               target.status === 'closing_processes' ||
               target.status === 'downloading' ||
               target.status === 'installing';
      });
    });
  };

  return {
    deployments,
    loading,
    error,
    createDeployment,
    cancelDeployment,
    deleteDeployment,
    checkMachineHasActiveDeployment
  };
}

// Convenience hook to get both templates and deployments
export function useDeploymentManager(siteId: string) {
  const templates = useDeploymentTemplates(siteId);
  const deployments = useDeployments(siteId);

  return {
    templates: templates.templates,
    templatesLoading: templates.loading,
    templatesError: templates.error,
    createTemplate: templates.createTemplate,
    updateTemplate: templates.updateTemplate,
    deleteTemplate: templates.deleteTemplate,

    deployments: deployments.deployments,
    deploymentsLoading: deployments.loading,
    deploymentsError: deployments.error,
    createDeployment: deployments.createDeployment,
    cancelDeployment: deployments.cancelDeployment,
    deleteDeployment: deployments.deleteDeployment,
    checkMachineHasActiveDeployment: deployments.checkMachineHasActiveDeployment,
  };
}

function deploymentsUrl(siteId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/deployments`;
}

function deploymentTemplateUrl(siteId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/presets/deployment-template`;
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
