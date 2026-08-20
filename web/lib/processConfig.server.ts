/**
 * Transactional mutation of the process array at
 * `config/{siteId}/machines/{machineId}`. Admin-SDK transactions here, unlike the
 * client hooks in useFirestore.ts which read-modify-write non-transactionally.
 *
 * - `withProcessConfig`: legacy admin-route helper (`id` field, no duplicate-name
 *   protection). Kept unchanged so the existing dashboard keeps working.
 * - `withProcessLock`: public-API helper (`processId`, lazy id backfill, rejects
 *   duplicate names inside the transaction).
 */

import { getAdminDb } from '@/lib/firebase-admin';
import crypto from 'crypto';

export interface ProcessConfig {
  /** Legacy id — kept for the dashboard hooks. */
  id: string;
  name: string;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  autolaunch: boolean;
  launch_mode: 'off' | 'always' | 'scheduled';
  schedules?: ScheduleBlock[] | null;
  schedulePresetId?: string | null;
  schedule?: { mode: 'off' | 'always' | 'scheduled'; blocks?: ScheduleBlock[] } | null;
  index?: number;
  /** Public-API id — same UUID as `id`. */
  processId?: string;
  [key: string]: unknown;
}

export interface ScheduleBlock {
  name?: string;
  colorIndex?: number;
  days: string[];
  ranges: { start: string; stop: string }[];
}

/**
 * Transactional mutation of a machine's process config array:
 * read → validate → mutate → write → configChangeFlag. Returns the mutator's result.
 */
export async function withProcessConfig<T>(
  siteId: string,
  machineId: string,
  mutator: (processes: ProcessConfig[]) => { processes: ProcessConfig[]; result: T }
): Promise<T> {
  const db = getAdminDb();
  const configRef = db.collection('config').doc(siteId).collection('machines').doc(machineId);

  const result = await db.runTransaction(async (transaction) => {
    const configSnap = await transaction.get(configRef);

    if (!configSnap.exists) {
      throw new ProcessConfigError(404, 'Configuration not found for this machine');
    }

    const config = configSnap.data()!;

    if (!config.processes || !Array.isArray(config.processes)) {
      throw new ProcessConfigError(500, 'Invalid configuration structure — no processes array');
    }

    const mutationResult = mutator(config.processes as ProcessConfig[]);

    // Firestore rejects undefined.
    const cleanedProcesses = mutationResult.processes.map(cleanProcessForFirestore);

    transaction.update(configRef, { processes: cleanedProcesses });

    return mutationResult.result;
  });

  // Nudge the agent; non-critical, it polls on its own cycle anyway.
  try {
    const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await statusRef.update({ configChangeFlag: true });
  } catch {
    // Ignore.
  }

  return result;
}

/** Strip undefined values and clean schedule blocks for Firestore. */
function cleanProcessForFirestore(process: ProcessConfig): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(process)) {
    if (value === undefined) continue;

    if (key === 'schedules' && Array.isArray(value)) {
      cleaned.schedules = value.map((block: ScheduleBlock) => {
        const cleanBlock: Record<string, unknown> = { days: block.days, ranges: block.ranges };
        if (block.name) cleanBlock.name = block.name;
        if (block.colorIndex != null) cleanBlock.colorIndex = block.colorIndex;
        return cleanBlock;
      });
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

export class ProcessConfigError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Public-API view of a process row: `processId` (server-generated UUID) is the
 * canonical id. Legacy `id` is held in lockstep with the same value because the
 * agent and the admin route still read it.
 */
export interface PublicProcessConfig extends ProcessConfig {
  processId: string;
}

/**
 * Transactional read-modify-write of `processes[]`: lazily backfills `processId`,
 * runs the mutator, then rejects duplicate names — the check is inside the txn,
 * which is what makes it race-safe. Sets `configChangeFlag` to nudge the agent.
 *
 * @throws ProcessConfigError 409 'duplicate_process_name', or 404 if no config doc.
 */
export async function withProcessLock<T>(
  siteId: string,
  machineId: string,
  fn: (processes: PublicProcessConfig[]) => { processes: PublicProcessConfig[]; result: T }
): Promise<T> {
  const db = getAdminDb();
  const configRef = db.collection('config').doc(siteId).collection('machines').doc(machineId);

  const result = await db.runTransaction(async (transaction) => {
    const configSnap = await transaction.get(configRef);

    if (!configSnap.exists) {
      throw new ProcessConfigError(404, 'Configuration not found for this machine');
    }

    const config = configSnap.data()!;
    if (!config.processes || !Array.isArray(config.processes)) {
      throw new ProcessConfigError(500, 'Invalid configuration structure — no processes array');
    }

    // Lazy backfill of `processId`.
    const normalized = (config.processes as ProcessConfig[]).map((p) => normalizeProcess(p));

    const mutationResult = fn(normalized);

    // Inside the txn, so the duplicate check is race-safe.
    assertUniqueNames(mutationResult.processes);

    const cleaned = mutationResult.processes.map(cleanProcessForFirestore);

    transaction.update(configRef, { processes: cleaned });

    return mutationResult.result;
  });

  // Non-critical: the agent polls on its own cycle.
  try {
    const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await statusRef.update({ configChangeFlag: true });
  } catch {
    // Ignore — agent polls config on its own cycle.
  }

  return result;
}

/**
 * Config-side process list with lazy `processId` backfill (GET list + detail).
 * Null when the machine has no config doc yet.
 */
export async function readProcessList(
  siteId: string,
  machineId: string
): Promise<PublicProcessConfig[] | null> {
  const db = getAdminDb();
  const configRef = db.collection('config').doc(siteId).collection('machines').doc(machineId);
  const snap = await configRef.get();

  if (!snap.exists) return null;
  const data = snap.data();
  if (!data?.processes || !Array.isArray(data.processes)) return [];

  const normalized = (data.processes as ProcessConfig[]).map((p) => normalizeProcess(p));

  // Persist the backfill if anything changed (best-effort, non-blocking).
  const needsWrite = normalized.some((n, i) => {
    const orig = data.processes[i] as ProcessConfig;
    return !orig.processId && n.processId;
  });
  if (needsWrite) {
    const cleaned = normalized.map(cleanProcessForFirestore);
    configRef.update({ processes: cleaned }).catch(() => {});
  }

  return normalized;
}

/** New server-side processId; centralized so every create path matches. */
export function generateProcessId(): string {
  return crypto.randomUUID();
}

/** Ensure `processId` exists and mirrors the legacy `id`. Idempotent. */
function normalizeProcess(p: ProcessConfig): PublicProcessConfig {
  const processId = p.processId || p.id || generateProcessId();
  return {
    ...p,
    id: processId,
    processId,
  };
}

/**
 * Throws 409 'duplicate_process_name' on a repeated `name`. Case-sensitive, to
 * match agent behaviour.
 */
function assertUniqueNames(processes: PublicProcessConfig[]): void {
  const seen = new Set<string>();
  for (const p of processes) {
    if (!p.name) continue;
    if (seen.has(p.name)) {
      throw new ProcessConfigError(
        409,
        `Duplicate process name: ${p.name}`,
        'duplicate_process_name'
      );
    }
    seen.add(p.name);
  }
}

/**
 * Index of a process by public-API id, or -1. Matches on `processId` only —
 * legacy `id`-only rows are normalized by `withProcessLock` before lookup.
 */
export function findProcessIndex(
  processes: PublicProcessConfig[],
  processId: string
): number {
  return processes.findIndex((p) => p.processId === processId);
}
