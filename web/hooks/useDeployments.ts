'use client';

import { useEffect, useState, useRef } from 'react';
import { collection, onSnapshot, doc, setDoc, getDoc, updateDoc, getDocs, deleteDoc, deleteField, query, orderBy, limit } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export interface DeploymentTemplate {
  id: string;
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path?: string;
  close_processes?: string[];
  createdAt: number;
}

export interface DeploymentTarget {
  machineId: string;
  status: 'pending' | 'closing_processes' | 'downloading' | 'installing' | 'completed' | 'failed' | 'cancelled' | 'uninstalled';
  progress?: number;
  error?: string;
  completedAt?: number;
  cancelledAt?: number;
  uninstalledAt?: number;
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
  targets: DeploymentTarget[];
  createdAt: number;
  completedAt?: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial' | 'uninstalled';
}

export function useDeploymentTemplates(siteId: string) {
  const [templates, setTemplates] = useState<DeploymentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      setError('Firebase not configured or no site selected');
      return;
    }

    try {
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
              createdAt: data.createdAt || Date.now(),
            });
          });

          // Sort by created date (newest first)
          templateData.sort((a, b) => b.createdAt - a.createdAt);

          setTemplates(templateData);
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching templates:', err);
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

  const createTemplate = async (template: Omit<DeploymentTemplate, 'id' | 'createdAt'>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateId = `template-${Date.now()}`;
    const templateRef = doc(db!, 'sites', siteId, 'installer_templates', templateId);

    await setDoc(templateRef, {
      ...template,
      createdAt: Date.now(),
    });

    return templateId;
  };

  const updateTemplate = async (templateId: string, template: Partial<Omit<DeploymentTemplate, 'id' | 'createdAt'>>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateRef = doc(db!, 'sites', siteId, 'installer_templates', templateId);
    await setDoc(templateRef, template, { merge: true });
  };

  const deleteTemplate = async (templateId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const templateRef = doc(db!, 'sites', siteId, 'installer_templates', templateId);
    await deleteDoc(templateRef);
  };

  return { templates, loading, error, createTemplate, updateTemplate, deleteTemplate };
}

export function useDeployments(siteId: string) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track processed commands across renders to prevent infinite loops
  const processedCommandsRef = useRef<Set<string>>(new Set());
  // Skip commands completed before this hook mounted (prevents re-processing old history)
  const mountTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!db || !siteId) {
      setLoading(false);
      setError('Firebase not configured or no site selected');
      return;
    }

    setLoading(true);

    try {
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
              targets: data.targets || [],
              createdAt: data.createdAt || Date.now(),
              completedAt: data.completedAt,
              status: data.status || 'pending',
            });
          });

          // Sort by created date (newest first)
          deploymentData.sort((a, b) => b.createdAt - a.createdAt);

          setDeployments(deploymentData);
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching deployments:', err);
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

  // Listen for command completions and update deployment status
  useEffect(() => {
    if (!db || !siteId || deployments.length === 0) return;

    const unsubscribes: (() => void)[] = [];
    // Use ref to persist processed commands across renders
    const processedCommands = processedCommandsRef.current;

    // OPTIMIZATION: Only listen to machines with ACTIVE deployment targets
    // This reduces Firebase read operations by only tracking machines that need updates
    const machineIds = new Set<string>();
    deployments.forEach(deployment => {
      // Only listen to deployments that are in-progress or pending
      if (deployment.status === 'in_progress' || deployment.status === 'pending') {
        deployment.targets.forEach(target => {
          // Only track targets with active status (not completed, failed, cancelled, or uninstalled)
          if (target.status === 'pending' ||
              target.status === 'closing_processes' ||
              target.status === 'downloading' ||
              target.status === 'installing') {
            machineIds.add(target.machineId);
          }
        });
      }
    });

    // Listen to completed commands for each machine
    machineIds.forEach(machineId => {
      const completedRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'completed');

      const unsubscribe = onSnapshot(
        completedRef,
        async (snapshot) => {
          if (!snapshot.exists()) return;

          const completedCommands = snapshot.data();

          // Check each completed command for deployment_id
          for (const [commandId, commandData] of Object.entries(completedCommands)) {
            const command = commandData as any;

            // Skip if we've already processed this command TO COMPLETION
            // (but allow intermediate status updates like downloading/installing)
            const isTerminalState = command.status === 'completed' ||
                                   command.status === 'failed' ||
                                   command.status === 'cancelled';

            if (processedCommands.has(commandId) && isTerminalState) {
              continue;
            }

            // Skip commands completed before this hook mounted — they're already
            // reflected in the deployment docs and don't need re-processing.
            if (isTerminalState && command.completedAt) {
              const completedMs = typeof command.completedAt === 'number'
                ? command.completedAt
                : command.completedAt?.seconds
                  ? command.completedAt.seconds * 1000
                  : command.completedAt?._seconds
                    ? command.completedAt._seconds * 1000
                    : 0;
              if (completedMs > 0 && completedMs < mountTimeRef.current) {
                processedCommands.add(commandId);
                continue;
              }
            }

            if (command.deployment_id) {
              const deploymentRef = doc(db!, 'sites', siteId, 'deployments', command.deployment_id);

              try {
                // Fetch the latest deployment document from Firestore (don't use stale local state)
                const deploymentSnap = await getDoc(deploymentRef);
                if (!deploymentSnap.exists()) {
                  console.debug(`[useDeployments] Deployment ${command.deployment_id} not found`);
                  continue;
                }

                const deployment = {
                  id: deploymentSnap.id,
                  ...deploymentSnap.data()
                } as Deployment;

                // Handle uninstall commands
                if (command.type === 'uninstall_software' && command.status === 'completed') {
                  const updatedTargets = deployment.targets.map(target => {
                    if (target.machineId === machineId) {
                      return {
                        ...target,
                        status: 'uninstalled' as const,
                        uninstalledAt: command.completedAt || Date.now()
                      };
                    }
                    return target;
                  });

                  // Calculate overall status - if all machines are uninstalled, mark deployment as uninstalled
                  const allUninstalled = updatedTargets.every(t => t.status === 'uninstalled');
                  const someUninstalled = updatedTargets.some(t => t.status === 'uninstalled');
                  const newStatus = allUninstalled ? 'uninstalled' : (someUninstalled ? 'partial' : deployment.status);

                  console.log(`[useDeployments] Updating deployment ${command.deployment_id} to status: ${newStatus}`);

                  // Update deployment
                  await setDoc(deploymentRef, {
                    targets: updatedTargets,
                    status: newStatus,
                  }, { merge: true });

                  console.log(`[useDeployments] Deployment ${command.deployment_id} updated successfully`);
                } else if (command.status === 'completed') {
                  // Handle completed installations
                  const updatedTargets = deployment.targets.map(target => {
                    if (target.machineId === machineId) {
                      // Create new target object without progress/error fields
                      const { progress, error, ...rest } = target;
                      return {
                        ...rest,
                        status: 'completed' as const,
                        completedAt: command.completedAt || Date.now()
                      };
                    }
                    return target;
                  });

                  // Calculate overall status
                  const allCompleted = updatedTargets.every(t => t.status === 'completed');
                  const anyFailed = updatedTargets.some(t => t.status === 'failed');
                  const newStatus = allCompleted ? 'completed' : anyFailed ? 'partial' : 'in_progress';

                  console.log(`[useDeployments] Updating deployment ${command.deployment_id} to status: ${newStatus}`);

                  // Update deployment
                  await setDoc(deploymentRef, {
                    targets: updatedTargets,
                    status: newStatus,
                    ...(allCompleted ? { completedAt: Date.now() } : {}),
                  }, { merge: true });

                  console.log(`[useDeployments] Deployment ${command.deployment_id} updated successfully`);
                } else if (command.status === 'failed') {
                  // Handle failed installations
                  const updatedTargets = deployment.targets.map(target => {
                    if (target.machineId === machineId) {
                      // Create new target object without progress field
                      const { progress, ...rest } = target;
                      return {
                        ...rest,
                        status: 'failed' as const,
                        ...(command.error ? { error: command.error } : {}),
                        completedAt: command.completedAt || Date.now()
                      };
                    }
                    return target;
                  });

                  // Calculate overall status
                  const allDone = updatedTargets.every(t => t.status === 'completed' || t.status === 'failed');
                  const anyCompleted = updatedTargets.some(t => t.status === 'completed');
                  const newStatus = allDone ? (anyCompleted ? 'partial' : 'failed') : 'in_progress';

                  console.log(`[useDeployments] Updating deployment ${command.deployment_id} to status: ${newStatus}`);

                  // Update deployment
                  await setDoc(deploymentRef, {
                    targets: updatedTargets,
                    status: newStatus,
                    ...(allDone ? { completedAt: Date.now() } : {}),
                  }, { merge: true });

                  console.log(`[useDeployments] Deployment ${command.deployment_id} updated successfully`);
                } else if (command.status === 'cancelled') {
                  // Handle cancelled installations
                  const updatedTargets = deployment.targets.map(target =>
                    target.machineId === machineId
                      ? { ...target, status: 'cancelled' as const, cancelledAt: command.completedAt || Date.now() }
                      : target
                  );

                  // Calculate overall status
                  // Cancelled targets don't affect the overall completion status
                  const remainingTargets = updatedTargets.filter(t => t.status !== 'cancelled');
                  const allCompleted = remainingTargets.length > 0 && remainingTargets.every(t => t.status === 'completed');
                  const anyFailed = remainingTargets.some(t => t.status === 'failed');
                  const anyInProgress = remainingTargets.some(t => t.status === 'pending' || t.status === 'closing_processes' || t.status === 'downloading' || t.status === 'installing');

                  let newStatus = deployment.status;
                  if (remainingTargets.length === 0) {
                    // All targets cancelled
                    newStatus = 'failed';
                  } else if (allCompleted) {
                    newStatus = 'completed';
                  } else if (anyFailed && !anyInProgress) {
                    newStatus = 'partial';
                  } else {
                    newStatus = 'in_progress';
                  }

                  console.log(`[useDeployments] Updating deployment ${command.deployment_id} to status: ${newStatus} (cancelled)`);

                  // Update deployment
                  await setDoc(deploymentRef, {
                    targets: updatedTargets,
                    status: newStatus,
                    ...(remainingTargets.length === 0 || (allCompleted && !anyInProgress) ? { completedAt: Date.now() } : {}),
                  }, { merge: true });

                  console.log(`[useDeployments] Deployment ${command.deployment_id} updated successfully`);
                } else if (command.status === 'closing_processes' || command.status === 'downloading' || command.status === 'installing') {
                  // Handle intermediate states (closing_processes, downloading, installing)
                  const updatedTargets = deployment.targets.map(target =>
                    target.machineId === machineId
                      ? {
                          ...target,
                          status: command.status as 'closing_processes' | 'downloading' | 'installing',
                          ...(command.progress !== undefined ? { progress: command.progress } : {})
                        }
                      : target
                  );

                  // Update deployment with new target status
                  await setDoc(deploymentRef, {
                    targets: updatedTargets,
                    status: 'in_progress',
                  }, { merge: true });

                  // Don't mark intermediate states as processed - allow future updates
                  continue;
                }

                // Mark this command as processed ONLY for terminal states
                // (completed, failed, cancelled handled above)
                processedCommands.add(commandId);
              } catch (error: any) {
                // Handle Firestore write errors gracefully
                console.error(`[useDeployments] Error updating deployment ${command.deployment_id}:`, error);
                // Still mark as processed even on error to avoid infinite retries
                processedCommands.add(commandId);
              }
            }
          }
        },
        (error) => {
          // Silently handle permission errors for machines that don't exist or are inaccessible
          // This prevents console spam when deployments reference deleted/offline machines
          console.debug(`[useDeployments] Listener error for machine ${machineId}:`, error.code);
        }
      );

      unsubscribes.push(unsubscribe);
    });

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [siteId, deployments]);

  const createDeployment = async (
    deployment: Omit<Deployment, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    console.log('[createDeployment] Starting deployment creation...', { siteId, machineIds });

    const deploymentId = `deploy-${Date.now()}`;
    const deploymentRef = doc(db!, 'sites', siteId, 'deployments', deploymentId);

    // Initialize targets with pending status
    const targets: DeploymentTarget[] = machineIds.map(machineId => ({
      machineId,
      status: 'pending',
    }));

    // Create deployment document (filter out undefined values)
    const deploymentData: any = {
      name: deployment.name,
      installer_name: deployment.installer_name,
      installer_url: deployment.installer_url,
      silent_flags: deployment.silent_flags,
      targets,
      createdAt: Date.now(),
      status: 'pending',
    };

    // Only include optional fields if provided
    if (deployment.verify_path) {
      deploymentData.verify_path = deployment.verify_path;
    }
    if (deployment.close_processes?.length) {
      deploymentData.close_processes = deployment.close_processes;
    }
    if (deployment.suppress_projects?.length) {
      deploymentData.suppress_projects = deployment.suppress_projects;
    }

    console.log('[createDeployment] Creating deployment document...', { deploymentId, deploymentData });
    await setDoc(deploymentRef, deploymentData);
    console.log('[createDeployment] Deployment document created successfully');

    // Send install command to each machine in parallel
    console.log('[createDeployment] Writing commands to machines...');
    const commandPromises = machineIds.map(async (machineId) => {
      // Use underscores to avoid Firestore field path parsing issues with hyphens
      const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${Date.now()}`;
      const commandRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'pending');

      const commandData: any = {
        type: 'install_software',
        installer_url: deployment.installer_url,
        installer_name: deployment.installer_name,
        silent_flags: deployment.silent_flags,
        deployment_id: deploymentId,
        timestamp: Date.now(),
        status: 'pending',
      };

      // Only include optional fields if provided
      if (deployment.verify_path) {
        commandData.verify_path = deployment.verify_path;
      }
      if (deployment.close_processes?.length) {
        commandData.close_processes = deployment.close_processes;
      }
      if (deployment.suppress_projects?.length) {
        // Filter suppress_projects to only include IDs that exist on this specific machine
        commandData.suppress_projects = deployment.suppress_projects;
      }

      console.log('[createDeployment] Writing command to machine:', { machineId, commandId, commandPath: `sites/${siteId}/machines/${machineId}/commands/pending` });
      await setDoc(commandRef, {
        [commandId]: commandData
      }, { merge: true });
      console.log('[createDeployment] Command written successfully for machine:', machineId);
    });

    // Wait for all commands to be sent
    await Promise.all(commandPromises);
    console.log('[createDeployment] All commands written successfully');

    // Update deployment status to in_progress
    console.log('[createDeployment] Updating deployment status to in_progress...');
    await setDoc(deploymentRef, {
      status: 'in_progress',
    }, { merge: true });
    console.log('[createDeployment] Deployment status updated successfully');

    return deploymentId;
  };

  const cancelDeployment = async (deploymentId: string, machineId: string, installer_name: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    try {
      // Send cancel command to the machine
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `cancel_${Date.now()}_${sanitizedMachineId}`;
      const commandRef = doc(db!, 'sites', siteId, 'machines', machineId, 'commands', 'pending');

      await setDoc(commandRef, {
        [commandId]: {
          type: 'cancel_installation',
          installer_name: installer_name,
          deployment_id: deploymentId,
          timestamp: Date.now(),
        }
      }, { merge: true });

      // Update deployment target status to 'cancelled'
      // This updates the UI optimistically while the agent processes the cancellation
      const deploymentRef = doc(db!, 'sites', siteId, 'deployments', deploymentId);
      const deploymentSnap = await getDoc(deploymentRef);

      if (deploymentSnap.exists()) {
        const deploymentData = deploymentSnap.data();
        const targets = deploymentData.targets || [];

        // Find and update the target's status to 'cancelled'
        const updatedTargets = targets.map((target: any) => {
          if (target.machineId === machineId) {
            return {
              ...target,
              status: 'cancelled',
              cancelledAt: Date.now(),
            };
          }
          return target;
        });

        // Update the deployment with the new target status
        await updateDoc(deploymentRef, {
          targets: updatedTargets,
          updatedAt: Date.now(),
        });
      }

      return commandId;
    } catch (error) {
      console.error('Error cancelling deployment:', error);
      throw error;
    }
  };

  const deleteDeployment = async (deploymentId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const deploymentRef = doc(db!, 'sites', siteId, 'deployments', deploymentId);
    await deleteDoc(deploymentRef);
  };

  const checkMachineHasActiveDeployment = (machineId: string): boolean => {
    return deployments.some(deployment => {
      // Check if deployment is active
      if (deployment.status !== 'pending' && deployment.status !== 'in_progress') {
        return false;
      }

      // Check if this machine is a target with active status
      return deployment.targets.some(target => {
        if (target.machineId !== machineId) return false;

        // Check if target status is active (not completed, failed, or cancelled)
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
