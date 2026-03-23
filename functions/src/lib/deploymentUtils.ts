/**
 * Shared Deployment Status Utilities
 *
 * Used by both the Firestore trigger (deploymentStatus.ts) and the
 * scheduled sweeper (deploymentSweeper.ts) to ensure consistent
 * status calculation logic.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface DeploymentTarget {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  completedAt?: number;
  cancelledAt?: number;
  uninstalledAt?: number;
}

/* -------------------------------------------------------------------------- */
/*  Command → Target status mapping                                           */
/* -------------------------------------------------------------------------- */

/**
 * Map a completed-command's status + type to the deployment target status.
 *
 * The agent writes commands with these statuses:
 *   Intermediate: downloading, installing, uninstalling
 *   Terminal:     completed, failed, cancelled
 *
 * The command `type` distinguishes install from uninstall completions.
 */
export function mapCommandToTargetStatus(
  commandStatus: string,
  commandType: string,
): string {
  // Intermediate states pass through directly
  if (['downloading', 'installing', 'uninstalling'].includes(commandStatus)) {
    return commandStatus;
  }

  // Terminal: cancelled is always cancelled
  if (commandStatus === 'cancelled') {
    return 'cancelled';
  }

  // Terminal: failed is always failed
  if (commandStatus === 'failed') {
    return 'failed';
  }

  // Terminal: completed — depends on command type
  if (commandStatus === 'completed') {
    if (commandType === 'uninstall_software') {
      return 'uninstalled';
    }
    return 'completed';
  }

  // Unknown status — pass through (shouldn't happen)
  return commandStatus;
}

/* -------------------------------------------------------------------------- */
/*  Deployment-level status calculation                                       */
/* -------------------------------------------------------------------------- */

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

  // All targets are terminal — determine overall status
  const statuses = new Set(targets.map((t) => t.status));

  if (statuses.size === 1) {
    const only = statuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'cancelled') return 'cancelled';
    if (only === 'uninstalled') return 'uninstalled';
    if (only === 'failed') return 'failed';
  }

  // Mixed terminal states
  return 'partial';
}
