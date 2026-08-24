/**
 * Deployment status calculation shared by the Firestore trigger
 * (deploymentStatus.ts) and the scheduled sweeper (deploymentSweeper.ts).
 */

// Constants

/** Target statuses that indicate the machine is done (success or failure). */
export const TARGET_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);

/** Deployment-level statuses that mean no more work is expected. */
export const DEPLOYMENT_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'partial',
  'cancelled',
  'uninstalled',
]);

// Types

export interface DeploymentTarget {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  completedAt?: number | FirebaseFirestore.Timestamp;
  cancelledAt?: number | FirebaseFirestore.Timestamp;
  uninstalledAt?: number | FirebaseFirestore.Timestamp;
}

// Command → Target status mapping

/**
 * Command status + type → deployment target status. Agent statuses are
 * downloading/installing/uninstalling (intermediate) and
 * completed/failed/cancelled (terminal); `type` separates install from
 * uninstall completions.
 */
export function mapCommandToTargetStatus(
  commandStatus: string,
  commandType: string,
): string {
  if (['downloading', 'installing', 'uninstalling'].includes(commandStatus)) {
    return commandStatus;
  }

  if (commandStatus === 'cancelled') {
    return 'cancelled';
  }

  if (commandStatus === 'failed') {
    return 'failed';
  }

  // completed — meaning depends on the command type.
  if (commandStatus === 'completed') {
    if (commandType === 'uninstall_software') {
      return 'uninstalled';
    }
    return 'completed';
  }

  // Unknown status — pass through.
  return commandStatus;
}

// Deployment-level status calculation

/**
 * Calculate the overall deployment status from the targets array.
 *
 * Rules (evaluated in order):
 * 1. If any target is non-terminal → in_progress
 * 2. All targets completed → completed
 * 3. All targets cancelled → cancelled
 * 4. All targets uninstalled → uninstalled
 * 5. Mixed terminal states → partial
 */
export function calculateDeploymentStatus(targets: DeploymentTarget[]): string {
  if (!targets || targets.length === 0) return 'pending';

  const hasNonTerminal = targets.some(
    (t) => !TARGET_TERMINAL_STATUSES.has(t.status)
  );

  if (hasNonTerminal) return 'in_progress';

  const statuses = new Set(targets.map((t) => t.status));

  if (statuses.size === 1) {
    const only = statuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'cancelled') return 'cancelled';
    if (only === 'uninstalled') return 'uninstalled';
    if (only === 'failed') return 'failed';
  }

  return 'partial';
}
