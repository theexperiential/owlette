'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot, doc, setDoc, getDocs, deleteDoc, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export interface ProjectDistributionTemplate {
  id: string;
  name: string;
  project_name: string;
  project_url: string;
  extract_path?: string;
  verify_files?: string[];
  createdAt: any; // Firestore Timestamp (new) or number (legacy)
}

export interface ProjectDistributionTarget {
  machineId: string;
  status: 'pending' | 'downloading' | 'extracting' | 'completed' | 'failed';
  progress?: number;
  error?: string;
  completedAt?: number;
}

export interface ProjectDistribution {
  id: string;
  name: string;
  project_name: string;
  project_url: string;
  extract_path?: string;
  verify_files?: string[];
  targets: ProjectDistributionTarget[];
  createdAt: any; // Firestore Timestamp (new) or number (legacy)
  completedAt?: any;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial';
}

export function useProjectDistributionTemplates(siteId: string) {
  const [templates, setTemplates] = useState<ProjectDistributionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      setError('Firebase not configured or no site selected');
      return;
    }

    try {
      const templatesRef = collection(db, 'sites', siteId, 'project_templates');

      const unsubscribe = onSnapshot(
        templatesRef,
        (snapshot) => {
          const templateData: ProjectDistributionTemplate[] = [];

          snapshot.forEach((doc) => {
            const data = doc.data();
            templateData.push({
              id: doc.id,
              name: data.name || 'Unnamed Template',
              project_name: data.project_name || '',
              project_url: data.project_url || '',
              extract_path: data.extract_path,
              verify_files: data.verify_files,
              createdAt: data.createdAt || Date.now(),
            });
          });

          // Sort by created date (newest first)
          templateData.sort((a, b) => (b.createdAt?.toMillis?.() ?? b.createdAt ?? 0) - (a.createdAt?.toMillis?.() ?? a.createdAt ?? 0));

          setTemplates(templateData);
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching project templates:', err);
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

  const createTemplate = async (template: Omit<ProjectDistributionTemplate, 'id' | 'createdAt'>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateId = `project-template-${Date.now()}`;
    const templateRef = doc(db!, 'sites', siteId, 'project_templates', templateId);

    await setDoc(templateRef, {
      ...template,
      createdAt: serverTimestamp(),
    });

    return templateId;
  };

  const updateTemplate = async (templateId: string, template: Partial<Omit<ProjectDistributionTemplate, 'id' | 'createdAt'>>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateRef = doc(db!, 'sites', siteId, 'project_templates', templateId);
    await setDoc(templateRef, template, { merge: true });
  };

  const deleteTemplate = async (templateId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateRef = doc(db!, 'sites', siteId, 'project_templates', templateId);
    await deleteDoc(templateRef);
  };

  return { templates, loading, error, createTemplate, updateTemplate, deleteTemplate };
}

export function useProjectDistributions(siteId: string) {
  const [distributions, setDistributions] = useState<ProjectDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      setError('Firebase not configured or no site selected');
      return;
    }

    try {
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
              project_name: data.project_name || '',
              project_url: data.project_url || '',
              extract_path: data.extract_path,
              verify_files: data.verify_files,
              targets: data.targets || [],
              createdAt: data.createdAt || Date.now(),
              completedAt: data.completedAt,
              status: data.status || 'pending',
            });
          });

          // Sort by created date (newest first)
          distributionData.sort((a, b) => (b.createdAt?.toMillis?.() ?? b.createdAt ?? 0) - (a.createdAt?.toMillis?.() ?? a.createdAt ?? 0));

          setDistributions(distributionData);
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching project distributions:', err);
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

  // Listen for command completions and update distribution status
  useEffect(() => {
    if (!db || !siteId || distributions.length === 0) return;

    const unsubscribes: (() => void)[] = [];

    // Get all unique machine IDs from in-progress distributions
    const machineIds = new Set<string>();
    distributions.forEach(distribution => {
      if (distribution.status === 'in_progress' || distribution.status === 'pending') {
        distribution.targets.forEach(target => machineIds.add(target.machineId));
      }
    });

    // Listen to completed commands for each machine
    machineIds.forEach(machineId => {
      const completedRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'completed');

      const unsubscribe = onSnapshot(completedRef, async (snapshot) => {
        if (!snapshot.exists()) return;

        const completedCommands = snapshot.data();

        // Check each completed command for distribution_id
        for (const [commandId, commandData] of Object.entries(completedCommands)) {
          const command = commandData as any;

          if (command.distribution_id) {
            const distribution = distributions.find(d => d.id === command.distribution_id);
            if (!distribution) continue;

            const distributionRef = doc(db!, 'sites', siteId, 'project_distributions', command.distribution_id);

            if (command.status === 'completed') {
              // Handle completed distributions
              const updatedTargets = distribution.targets.map(target =>
                target.machineId === machineId
                  ? { ...target, status: 'completed' as const, completedAt: command.completedAt || new Date() }
                  : target
              );

              // Calculate overall status
              const allCompleted = updatedTargets.every(t => t.status === 'completed');
              const anyFailed = updatedTargets.some(t => t.status === 'failed');
              const newStatus = allCompleted ? 'completed' : anyFailed ? 'partial' : 'in_progress';

              // Update distribution
              await setDoc(distributionRef, {
                targets: updatedTargets,
                status: newStatus,
                ...(allCompleted ? { completedAt: serverTimestamp() } : {}),
              }, { merge: true });
            } else if (command.status === 'failed') {
              // Handle failed distributions
              const updatedTargets = distribution.targets.map(target =>
                target.machineId === machineId
                  ? { ...target, status: 'failed' as const, error: command.error, completedAt: command.completedAt || new Date() }
                  : target
              );

              // Calculate overall status
              const allDone = updatedTargets.every(t => t.status === 'completed' || t.status === 'failed');
              const anyCompleted = updatedTargets.some(t => t.status === 'completed');
              const newStatus = allDone ? (anyCompleted ? 'partial' : 'failed') : 'in_progress';

              // Update distribution
              await setDoc(distributionRef, {
                targets: updatedTargets,
                status: newStatus,
                ...(allDone ? { completedAt: serverTimestamp() } : {}),
              }, { merge: true });
            } else if (command.status === 'downloading' || command.status === 'extracting') {
              // Handle intermediate states (downloading, extracting)
              const updatedTargets = distribution.targets.map(target =>
                target.machineId === machineId
                  ? { ...target, status: command.status as 'downloading' | 'extracting', progress: command.progress }
                  : target
              );

              // Update distribution with new target status
              await setDoc(distributionRef, {
                targets: updatedTargets,
                status: 'in_progress',
              }, { merge: true });
            }
          }
        }
      });

      unsubscribes.push(unsubscribe);
    });

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [siteId, distributions]);

  const createDistribution = async (
    distribution: Omit<ProjectDistribution, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const distributionId = `project-dist-${Date.now()}`;
    const distributionRef = doc(db!, 'sites', siteId, 'project_distributions', distributionId);

    // Initialize targets with pending status
    const targets: ProjectDistributionTarget[] = machineIds.map(machineId => ({
      machineId,
      status: 'pending',
    }));

    // Create distribution document
    await setDoc(distributionRef, {
      ...distribution,
      targets,
      createdAt: serverTimestamp(),
      status: 'pending',
    });

    // Send distribute_project command to each machine in parallel
    const commandPromises = machineIds.map(async (machineId) => {
      // Use underscores to avoid Firestore field path parsing issues with hyphens
      const sanitizedDistributionId = distributionId.replace(/-/g, '_');
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `distribute_${sanitizedDistributionId}_${sanitizedMachineId}_${Date.now()}`;
      const commandRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'pending');

      await setDoc(commandRef, {
        [commandId]: {
          type: 'distribute_project',
          project_url: distribution.project_url,
          project_name: distribution.project_name,
          extract_path: distribution.extract_path,
          verify_files: distribution.verify_files,
          distribution_id: distributionId,
          timestamp: serverTimestamp(),
          status: 'pending',
        }
      }, { merge: true });
    });

    // Wait for all commands to be sent
    await Promise.all(commandPromises);

    // Update distribution status to in_progress
    await setDoc(distributionRef, {
      status: 'in_progress',
    }, { merge: true });

    return distributionId;
  };

  const cancelDistribution = async (distributionId: string, machineId: string, project_name: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    // Send cancel command to the machine
    const sanitizedMachineId = machineId.replace(/-/g, '_');
    const commandId = `cancel_${Date.now()}_${sanitizedMachineId}`;
    const commandRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'pending');

    await setDoc(commandRef, {
      [commandId]: {
        type: 'cancel_distribution',
        project_name: project_name,
        distribution_id: distributionId,
        timestamp: serverTimestamp(),
      }
    }, { merge: true });

    return commandId;
  };

  const deleteDistribution = async (distributionId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const distributionRef = doc(db!, 'sites', siteId, 'project_distributions', distributionId);
    await deleteDoc(distributionRef);
  };

  return { distributions, loading, error, createDistribution, cancelDistribution, deleteDistribution };
}

// Convenience hook to get both templates and distributions
export function useProjectDistributionManager(siteId: string) {
  const templates = useProjectDistributionTemplates(siteId);
  const distributions = useProjectDistributions(siteId);

  return {
    templates: templates.templates,
    templatesLoading: templates.loading,
    templatesError: templates.error,
    createTemplate: templates.createTemplate,
    updateTemplate: templates.updateTemplate,
    deleteTemplate: templates.deleteTemplate,

    distributions: distributions.distributions,
    distributionsLoading: distributions.loading,
    distributionsError: distributions.error,
    createDistribution: distributions.createDistribution,
    cancelDistribution: distributions.cancelDistribution,
    deleteDistribution: distributions.deleteDistribution,
  };
}
