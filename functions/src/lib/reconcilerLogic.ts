/**
 * Pure decision logic for the listener-driven write reconcilers
 * (security-boundary-migration wave 2.4).
 *
 * Two cloud functions — `reconcileDeploymentStatus` and
 * `reconcileDistributionStatus` — replace the client-side status
 * mutations that previously lived in `useDeployments.ts` and
 * `useProjectDistributions.ts`. After security-boundary rules lockdown
 * the dashboard cannot write back to deployment / distribution docs;
 * the cloud function now owns that reconciliation.
 *
 * Each reconciler triggers on the per-machine pending-commands map doc
 * (`sites/{siteId}/machines/{machineId}/commands/pending`). When an
 * agent flips a command entry's `status` field (e.g. `pending →
 * downloading`, `downloading → completed`), the trigger inspects the
 * before/after diff, looks up the parent deployment / distribution, and
 * recomputes the aggregate status from the current `targets[]` array.
 *
 * **Idempotency** is enforced via the per-command `auditCorrelationId`
 * carried on the command entry. The reconciler stamps that same id
 * onto the matching target and remembers it as
 * `lastProcessedCommandCorrelationId`. A duplicate trigger firing for
 * the same command sees the id already on the target and bails out
 * without writing — proven by the test suite.
 *
 * This file is pure: no firestore, no admin sdk. Handlers in the two
 * `reconcile*Status.ts` files load state, feed into these helpers, and
 * persist the resulting decision. That separation is what makes the
 * suite testable from `web/__tests__/functions/reconciler.test.ts`
 * without booting the firestore emulator (wave 1.7's job).
 */

/* -------------------------------------------------------------------------- */
/*  Shared types                                                              */
/* -------------------------------------------------------------------------- */

/** Agent-reported intermediate states for an install/uninstall command. */
export const DEPLOYMENT_INTERMEDIATE_STATUSES = [
  'closing_processes',
  'downloading',
  'installing',
  'uninstalling',
] as const;

/** Agent-reported intermediate states for a distribute_project command. */
export const DISTRIBUTION_INTERMEDIATE_STATUSES = [
  'downloading',
  'extracting',
] as const;

/** Target statuses that mean "no further work expected" for deployments. */
export const DEPLOYMENT_TARGET_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);

/** Deployment-level statuses that mean "no further work expected". */
export const DEPLOYMENT_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'partial',
  'cancelled',
  'uninstalled',
]);

/** Target statuses that mean "no further work expected" for distributions. */
export const DISTRIBUTION_TARGET_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
]);

/** Distribution-level terminal statuses. */
export const DISTRIBUTION_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'partial',
  'cancelled',
]);

export interface CommandEntry {
  type?: string;
  status?: string;
  progress?: number;
  error?: string;
  deployment_id?: string;
  distribution_id?: string;
  /**
   * Stable join key minted by the API at command-creation time. Reused
   * here as the idempotency key — the parent target stores the most
   * recent correlation id it processed; replays compare and short-circuit.
   */
  auditCorrelationId?: string;
  /**
   * Best-effort monotone clock. Used as a tiebreaker if the same command
   * key is updated multiple times in a single trigger window — pick the
   * latest by timestamp, not whichever Object.entries iterated last.
   */
  updatedAt?: number;
  completedAt?: number;
}

export interface DeploymentTarget {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  /**
   * Most recent command correlation id that mutated this target. Set by
   * the reconciler; consulted on replay to skip duplicate writes.
   */
  lastProcessedCommandCorrelationId?: string;
  completedAt?: unknown;
  cancelledAt?: unknown;
  uninstalledAt?: unknown;
}

export interface DistributionTarget {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  lastProcessedCommandCorrelationId?: string;
  completedAt?: unknown;
}

/* -------------------------------------------------------------------------- */
/*  Diff: detect command entries whose status changed                         */
/* -------------------------------------------------------------------------- */

export interface ChangedCommand {
  cmdId: string;
  before: CommandEntry | undefined;
  after: CommandEntry;
}

/**
 * Compare two snapshots of a `commands/pending` map doc and return only
 * the entries whose status (or progress) changed, or that appeared for
 * the first time. Deletions are ignored — once an agent moves a command
 * to `commands/completed` the pending entry is dropped, but the
 * authoritative status was already observed by the prior trigger.
 */
export function diffCommandMap(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangedCommand[] {
  const changed: ChangedCommand[] = [];
  for (const [cmdId, raw] of Object.entries(after)) {
    if (!raw || typeof raw !== 'object') continue;
    const afterCmd = raw as CommandEntry;
    const beforeRaw = before[cmdId];
    const beforeCmd =
      beforeRaw && typeof beforeRaw === 'object'
        ? (beforeRaw as CommandEntry)
        : undefined;

    if (!beforeCmd) {
      changed.push({ cmdId, before: undefined, after: afterCmd });
      continue;
    }
    if (
      beforeCmd.status !== afterCmd.status ||
      beforeCmd.progress !== afterCmd.progress ||
      beforeCmd.auditCorrelationId !== afterCmd.auditCorrelationId
    ) {
      changed.push({ cmdId, before: beforeCmd, after: afterCmd });
    }
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/*  Idempotency check                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `true` if the parent target already records this exact command
 * correlation id — the reconciler ran already and a replay should be a
 * no-op. `false` for first-time observation OR when the command lacks a
 * correlation id (unattributable; let the reconcile run, but it can't
 * fully self-deduplicate).
 */
export function isAlreadyProcessed(
  target: { lastProcessedCommandCorrelationId?: string } | undefined,
  cmd: Pick<CommandEntry, 'auditCorrelationId'>,
): boolean {
  if (!target || !cmd.auditCorrelationId) return false;
  return target.lastProcessedCommandCorrelationId === cmd.auditCorrelationId;
}

/* -------------------------------------------------------------------------- */
/*  Deployment status mapping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map an agent-reported command status + type onto the deployment
 * target status. Mirrors the historical client-side behaviour from
 * `useDeployments.ts` (and the existing `mapCommandToTargetStatus` in
 * `lib/deploymentUtils.ts`) — exposed here to keep the wave-2.4
 * reconciler self-contained and indistinguishable from the legacy code
 * it replaces.
 */
export function mapDeploymentCommandStatus(
  commandStatus: string | undefined,
  commandType: string | undefined,
): string {
  if (!commandStatus) return 'pending';

  if (
    (DEPLOYMENT_INTERMEDIATE_STATUSES as readonly string[]).includes(
      commandStatus,
    )
  ) {
    return commandStatus;
  }

  if (commandStatus === 'cancelled') return 'cancelled';
  if (commandStatus === 'failed') return 'failed';

  if (commandStatus === 'completed') {
    if (commandType === 'uninstall_software') return 'uninstalled';
    return 'completed';
  }

  // Unknown / pending — pass through. `pending` is the initial state and
  // shouldn't overwrite anything terminal (caller handles that).
  return commandStatus;
}

/**
 * Aggregate deployment-level status from the current targets[] array.
 * Rules (in order):
 *   1. any target non-terminal             → in_progress
 *   2. all targets share one terminal      → that status
 *   3. cancellation is a wash; ignore it for "all terminal" classification
 *      and re-evaluate the remaining targets (all-completed → completed,
 *      any-failed → partial, etc.)
 *   4. mixed terminal states               → partial
 */
export function calculateDeploymentStatus(
  targets: readonly DeploymentTarget[],
): string {
  if (!targets || targets.length === 0) return 'pending';

  const hasNonTerminal = targets.some(
    (t) => !DEPLOYMENT_TARGET_TERMINAL_STATUSES.has(t.status),
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

  // Cancellations don't poison an otherwise-successful rollout. Strip
  // them and reclassify the survivors so `[completed, completed,
  // cancelled]` reads as `completed`, not `partial`. Matches the
  // historical `useDeployments` client-side behaviour.
  const survivors = targets.filter((t) => t.status !== 'cancelled');
  if (survivors.length === 0) return 'cancelled';

  const survivorStatuses = new Set(survivors.map((t) => t.status));
  if (survivorStatuses.size === 1) {
    const only = survivorStatuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'uninstalled') return 'uninstalled';
    if (only === 'failed') return 'failed';
  }

  return 'partial';
}

/* -------------------------------------------------------------------------- */
/*  Distribution status mapping                                               */
/* -------------------------------------------------------------------------- */

/** Map a distribute_project command status to the target status. */
export function mapDistributionCommandStatus(
  commandStatus: string | undefined,
): string {
  if (!commandStatus) return 'pending';

  if (
    (DISTRIBUTION_INTERMEDIATE_STATUSES as readonly string[]).includes(
      commandStatus,
    )
  ) {
    return commandStatus;
  }

  if (commandStatus === 'cancelled') return 'cancelled';
  if (commandStatus === 'failed') return 'failed';
  if (commandStatus === 'completed') return 'completed';

  return commandStatus;
}

/**
 * Aggregate distribution-level status. Same shape as the deployment
 * version but the target vocabulary excludes `uninstalled`.
 */
export function calculateDistributionStatus(
  targets: readonly DistributionTarget[],
): string {
  if (!targets || targets.length === 0) return 'pending';

  const hasNonTerminal = targets.some(
    (t) => !DISTRIBUTION_TARGET_TERMINAL_STATUSES.has(t.status),
  );
  if (hasNonTerminal) return 'in_progress';

  const statuses = new Set(targets.map((t) => t.status));
  if (statuses.size === 1) {
    const only = statuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'cancelled') return 'cancelled';
    if (only === 'failed') return 'failed';
  }

  const survivors = targets.filter((t) => t.status !== 'cancelled');
  if (survivors.length === 0) return 'cancelled';

  const survivorStatuses = new Set(survivors.map((t) => t.status));
  if (survivorStatuses.size === 1) {
    const only = survivorStatuses.values().next().value as string;
    if (only === 'completed') return 'completed';
    if (only === 'failed') return 'failed';
  }

  return 'partial';
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation: compute target + parent updates                           */
/* -------------------------------------------------------------------------- */

/**
 * Pick the most recent observation for a given (deployment_id |
 * distribution_id, machine) tuple. If multiple changed-command entries
 * map to the same parent + machine, keep the one with the largest
 * `updatedAt` (or `completedAt` if no `updatedAt`). Falls back to
 * iteration order when no clock is available.
 */
function pickLatest(commands: ChangedCommand[]): ChangedCommand {
  if (commands.length === 1) return commands[0];
  let latest = commands[0];
  for (let i = 1; i < commands.length; i++) {
    const a = commands[i].after;
    const b = latest.after;
    const aTs = a.updatedAt ?? a.completedAt ?? 0;
    const bTs = b.updatedAt ?? b.completedAt ?? 0;
    if (aTs > bTs) latest = commands[i];
  }
  return latest;
}

export interface DeploymentReconcileInput {
  /** Existing parent doc (deployment). */
  deployment: { status?: string; targets?: DeploymentTarget[] };
  /** All changed commands for this (deployment, machine) tuple. */
  commands: ChangedCommand[];
  /** The machine id the commands belong to. */
  machineId: string;
}

export type ReconcileSkipReason =
  | 'no_changes'
  | 'machine_not_targeted'
  | 'already_processed'
  | 'no_status_change';

export type DeploymentReconcileOutput =
  | { kind: 'skip'; reason: ReconcileSkipReason }
  | {
      kind: 'apply';
      /** Updated `targets[]` array — write back as a whole-array set. */
      targets: DeploymentTarget[];
      /** New deployment-level status (may equal current — caller can no-op). */
      status: string;
      /** Whether the deployment just transitioned into a terminal state. */
      becameTerminal: boolean;
      /** Correlation id that drove this update (for audit linkage). */
      correlationId: string | undefined;
      /** Updated target index — useful for tests and structured logs. */
      targetIndex: number;
    };

/**
 * Compute the new state for a deployment doc given a set of changed
 * commands. Returns a `skip` verdict when nothing should be written
 * (idempotency, machine not in targets, etc.) so the handler can avoid
 * needless writes and audit entries.
 */
export function reconcileDeployment(
  input: DeploymentReconcileInput,
): DeploymentReconcileOutput {
  const { deployment, commands, machineId } = input;
  if (commands.length === 0) return { kind: 'skip', reason: 'no_changes' };

  const targets: DeploymentTarget[] = (deployment.targets || []).map((t) => ({
    ...t,
  }));
  const targetIndex = targets.findIndex((t) => t.machineId === machineId);
  if (targetIndex === -1) {
    return { kind: 'skip', reason: 'machine_not_targeted' };
  }

  const latest = pickLatest(commands);
  const target = targets[targetIndex];

  // Idempotency: same correlation id already recorded → nothing to do.
  if (isAlreadyProcessed(target, latest.after)) {
    return { kind: 'skip', reason: 'already_processed' };
  }

  const newStatus = mapDeploymentCommandStatus(
    latest.after.status,
    latest.after.type,
  );

  // Don't downgrade a terminal target to an intermediate state. The
  // legacy `useDeployments` hook had the same guard.
  if (
    DEPLOYMENT_TARGET_TERMINAL_STATUSES.has(target.status) &&
    !DEPLOYMENT_TARGET_TERMINAL_STATUSES.has(newStatus)
  ) {
    // Stamp the correlation id even when we skip the status change so
    // future replays of the same command short-circuit on idempotency.
    if (latest.after.auditCorrelationId) {
      target.lastProcessedCommandCorrelationId = latest.after.auditCorrelationId;
      targets[targetIndex] = target;
      return {
        kind: 'apply',
        targets,
        status: deployment.status ?? calculateDeploymentStatus(targets),
        becameTerminal: false,
        correlationId: latest.after.auditCorrelationId,
        targetIndex,
      };
    }
    return { kind: 'skip', reason: 'no_status_change' };
  }

  // Apply target update.
  target.status = newStatus;
  if (latest.after.progress !== undefined) {
    target.progress = latest.after.progress;
  }
  if (latest.after.error) {
    target.error = latest.after.error;
  }
  if (latest.after.auditCorrelationId) {
    target.lastProcessedCommandCorrelationId = latest.after.auditCorrelationId;
  }
  // Clear progress on terminal — matches legacy hook behaviour.
  if (DEPLOYMENT_TARGET_TERMINAL_STATUSES.has(newStatus)) {
    delete target.progress;
  }
  targets[targetIndex] = target;

  const previousStatus = deployment.status ?? 'pending';
  const newDeploymentStatus = calculateDeploymentStatus(targets);
  const wasTerminal = DEPLOYMENT_TERMINAL_STATUSES.has(previousStatus);
  const isTerminal = DEPLOYMENT_TERMINAL_STATUSES.has(newDeploymentStatus);

  return {
    kind: 'apply',
    targets,
    status: newDeploymentStatus,
    becameTerminal: !wasTerminal && isTerminal,
    correlationId: latest.after.auditCorrelationId,
    targetIndex,
  };
}

/* -------------------------------------------------------------------------- */
/*  Distribution reconciliation                                               */
/* -------------------------------------------------------------------------- */

export interface DistributionReconcileInput {
  distribution: { status?: string; targets?: DistributionTarget[] };
  commands: ChangedCommand[];
  machineId: string;
}

export type DistributionReconcileOutput =
  | { kind: 'skip'; reason: ReconcileSkipReason }
  | {
      kind: 'apply';
      targets: DistributionTarget[];
      status: string;
      becameTerminal: boolean;
      correlationId: string | undefined;
      targetIndex: number;
    };

export function reconcileDistribution(
  input: DistributionReconcileInput,
): DistributionReconcileOutput {
  const { distribution, commands, machineId } = input;
  if (commands.length === 0) return { kind: 'skip', reason: 'no_changes' };

  const targets: DistributionTarget[] = (distribution.targets || []).map(
    (t) => ({ ...t }),
  );
  const targetIndex = targets.findIndex((t) => t.machineId === machineId);
  if (targetIndex === -1) {
    return { kind: 'skip', reason: 'machine_not_targeted' };
  }

  const latest = pickLatest(commands);
  const target = targets[targetIndex];

  if (isAlreadyProcessed(target, latest.after)) {
    return { kind: 'skip', reason: 'already_processed' };
  }

  const newStatus = mapDistributionCommandStatus(latest.after.status);

  if (
    DISTRIBUTION_TARGET_TERMINAL_STATUSES.has(target.status) &&
    !DISTRIBUTION_TARGET_TERMINAL_STATUSES.has(newStatus)
  ) {
    if (latest.after.auditCorrelationId) {
      target.lastProcessedCommandCorrelationId = latest.after.auditCorrelationId;
      targets[targetIndex] = target;
      return {
        kind: 'apply',
        targets,
        status: distribution.status ?? calculateDistributionStatus(targets),
        becameTerminal: false,
        correlationId: latest.after.auditCorrelationId,
        targetIndex,
      };
    }
    return { kind: 'skip', reason: 'no_status_change' };
  }

  target.status = newStatus;
  if (latest.after.progress !== undefined) {
    target.progress = latest.after.progress;
  }
  if (latest.after.error) {
    target.error = latest.after.error;
  }
  if (latest.after.auditCorrelationId) {
    target.lastProcessedCommandCorrelationId = latest.after.auditCorrelationId;
  }
  if (DISTRIBUTION_TARGET_TERMINAL_STATUSES.has(newStatus)) {
    delete target.progress;
  }
  targets[targetIndex] = target;

  const previousStatus = distribution.status ?? 'pending';
  const newDistributionStatus = calculateDistributionStatus(targets);
  const wasTerminal = DISTRIBUTION_TERMINAL_STATUSES.has(previousStatus);
  const isTerminal = DISTRIBUTION_TERMINAL_STATUSES.has(newDistributionStatus);

  return {
    kind: 'apply',
    targets,
    status: newDistributionStatus,
    becameTerminal: !wasTerminal && isTerminal,
    correlationId: latest.after.auditCorrelationId,
    targetIndex,
  };
}

/* -------------------------------------------------------------------------- */
/*  Group changed commands by parent doc id                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bucket changed commands by `deployment_id`. Commands without a
 * `deployment_id` are ignored — they belong to a different reconciler.
 */
export function groupByDeploymentId(
  commands: ChangedCommand[],
): Map<string, ChangedCommand[]> {
  const groups = new Map<string, ChangedCommand[]>();
  for (const cmd of commands) {
    const id = cmd.after.deployment_id;
    if (!id) continue;
    const list = groups.get(id);
    if (list) list.push(cmd);
    else groups.set(id, [cmd]);
  }
  return groups;
}

export function groupByDistributionId(
  commands: ChangedCommand[],
): Map<string, ChangedCommand[]> {
  const groups = new Map<string, ChangedCommand[]>();
  for (const cmd of commands) {
    const id = cmd.after.distribution_id;
    if (!id) continue;
    const list = groups.get(id);
    if (list) list.push(cmd);
    else groups.set(id, [cmd]);
  }
  return groups;
}
