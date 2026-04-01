/**
 * Deployment Status Cloud Function
 *
 * Firestore trigger that fires when the agent writes command results to
 * sites/{siteId}/machines/{machineId}/commands/completed.
 *
 * For each command that has a deployment_id, this function:
 * 1. Reads the deployment doc
 * 2. Updates the matching target's status, progress, error, and timestamps
 * 3. Recalculates the overall deployment status
 * 4. Writes back to the deployment doc
 *
 * This replaces the client-side status mutation that previously lived in
 * the useDeployments React hook, making deployment status observable by
 * any consumer (API, tests, scripts) without requiring the dashboard.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import {
  mapCommandToTargetStatus,
  calculateDeploymentStatus,
  TARGET_TERMINAL_STATUSES,
  type DeploymentTarget,
} from './lib/deploymentUtils';

const db = admin.firestore();

/**
 * Triggered on every write to a machine's completed commands document.
 * Diffs before/after to find commands that changed, then updates the
 * corresponding deployment doc for each.
 */
export const onCommandCompleted = onDocumentWritten(
  'sites/{siteId}/machines/{machineId}/commands/completed',
  async (event) => {
    const { siteId, machineId } = event.params;

    const beforeData = event.data?.before?.data() || {};
    const afterData = event.data?.after?.data() || {};

    // Find commands that were added or changed
    const changedCommands: Array<{ cmdId: string; cmdData: Record<string, any> }> = [];

    for (const [cmdId, cmdData] of Object.entries(afterData)) {
      if (typeof cmdData !== 'object' || !cmdData) continue;

      const beforeCmd = beforeData[cmdId] as Record<string, any> | undefined;

      // New command or status changed
      if (
        !beforeCmd ||
        beforeCmd.status !== cmdData.status ||
        beforeCmd.progress !== cmdData.progress
      ) {
        changedCommands.push({ cmdId, cmdData: cmdData as Record<string, any> });
      }
    }

    if (changedCommands.length === 0) return;

    // Group changes by deployment_id to batch updates
    const deploymentUpdates = new Map<
      string,
      Array<{ cmdId: string; cmdData: Record<string, any> }>
    >();

    for (const cmd of changedCommands) {
      const deploymentId = cmd.cmdData.deployment_id;
      if (!deploymentId) continue; // Not a deployment command

      if (!deploymentUpdates.has(deploymentId)) {
        deploymentUpdates.set(deploymentId, []);
      }
      deploymentUpdates.get(deploymentId)!.push(cmd);
    }

    if (deploymentUpdates.size === 0) return;

    // Process each deployment
    const promises = Array.from(deploymentUpdates.entries()).map(
      ([deploymentId, commands]) =>
        updateDeployment(siteId, machineId, deploymentId, commands)
    );

    await Promise.all(promises);
  }
);

/**
 * Update a single deployment doc based on command changes for one machine.
 */
async function updateDeployment(
  siteId: string,
  machineId: string,
  deploymentId: string,
  commands: Array<{ cmdId: string; cmdData: Record<string, any> }>,
): Promise<void> {
  const deploymentRef = db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId);

  const deploymentSnap = await deploymentRef.get();

  if (!deploymentSnap.exists) {
    console.warn(
      `Deployment ${deploymentId} not found for command update ` +
      `(site: ${siteId}, machine: ${machineId}). May have been deleted.`
    );
    return;
  }

  const deploymentData = deploymentSnap.data()!;
  const targets: DeploymentTarget[] = deploymentData.targets || [];

  // Find the target for this machine
  const targetIndex = targets.findIndex((t) => t.machineId === machineId);
  if (targetIndex === -1) {
    console.warn(
      `Machine ${machineId} not found in deployment ${deploymentId} targets`
    );
    return;
  }

  const target = { ...targets[targetIndex] };
  const currentStatus = target.status;

  // If target is already terminal, don't overwrite with intermediate states
  if (TARGET_TERMINAL_STATUSES.has(currentStatus)) {
    // Allow overwrite only if new status is also terminal (e.g. uninstall after install)
    const hasTerminalUpdate = commands.some((cmd) => {
      const newStatus = mapCommandToTargetStatus(
        cmd.cmdData.status,
        cmd.cmdData.type || ''
      );
      return TARGET_TERMINAL_STATUSES.has(newStatus);
    });

    if (!hasTerminalUpdate) return;
  }

  // Apply the most recent command status (commands are in write order)
  // Use the last command as it represents the latest state
  const latestCmd = commands[commands.length - 1].cmdData;
  const newTargetStatus = mapCommandToTargetStatus(
    latestCmd.status,
    latestCmd.type || ''
  );

  // Skip write if nothing changed
  if (
    newTargetStatus === currentStatus &&
    latestCmd.progress === target.progress
  ) {
    return;
  }

  // Update target fields
  target.status = newTargetStatus;

  if (latestCmd.progress !== undefined) {
    target.progress = latestCmd.progress;
  }

  if (latestCmd.error) {
    target.error = latestCmd.error;
  }

  // Set timestamps based on terminal status
  if (TARGET_TERMINAL_STATUSES.has(newTargetStatus)) {
    delete target.progress; // Clear progress on terminal
    const now = Date.now();

    if (newTargetStatus === 'cancelled') {
      target.cancelledAt = now;
    } else if (newTargetStatus === 'uninstalled') {
      target.uninstalledAt = now;
    } else {
      target.completedAt = now;
    }
  }

  // Write updated target back
  const updatedTargets = [...targets];
  updatedTargets[targetIndex] = target;

  // Recalculate overall deployment status
  const newDeploymentStatus = calculateDeploymentStatus(updatedTargets);

  const updatePayload: Record<string, unknown> = {
    targets: updatedTargets,
    updatedAt: Date.now(),
  };

  // Set deployment-level status
  if (newDeploymentStatus !== deploymentData.status) {
    updatePayload.status = newDeploymentStatus;
  }

  // Set completedAt if deployment just became terminal
  const isNowTerminal = [
    'completed', 'failed', 'partial', 'cancelled', 'uninstalled',
  ].includes(newDeploymentStatus);
  const wasTerminal = [
    'completed', 'failed', 'partial', 'cancelled', 'uninstalled',
  ].includes(deploymentData.status);

  if (isNowTerminal && !wasTerminal) {
    updatePayload.completedAt = Date.now();
  }

  await deploymentRef.update(updatePayload);

  console.log(
    `Deployment ${deploymentId}: machine ${machineId} -> ${newTargetStatus}, ` +
    `overall -> ${newDeploymentStatus}`
  );
}
