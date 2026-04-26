/**
 * Shared Process Config Mutation Helper
 *
 * Provides a transactional wrapper for mutating the process config array
 * stored at `config/{siteId}/machines/{machineId}`. Eliminates duplicated
 * boilerplate across process CRUD API endpoints.
 *
 * Uses Firestore Admin SDK transactions to prevent race conditions
 * (the client-side hooks in useFirestore.ts do non-transactional read-modify-write).
 *
 * Two helpers are exposed:
 * - `withProcessConfig`: legacy admin-route helper (uses `id` field, no
 *   duplicate-name protection). Kept unchanged to avoid breaking the
 *   existing dashboard.
 * - `withProcessLock`: public-API helper (uses `processId` field, lazily
 *   backfills missing ids, rejects duplicate names inside the transaction).
 */

import { getAdminDb } from '@/lib/firebase-admin';
import crypto from 'crypto';

export interface ProcessConfig {
  /** Legacy id field — historical name kept for compatibility with dashboard hooks. */
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
  /** Public-API id (Wave 2 — same UUID, exposed under `processId`). */
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
 * Execute a transactional mutation on a machine's process config array.
 *
 * Handles: config read → validation → mutation → write → configChangeFlag.
 *
 * @param siteId - The site ID
 * @param machineId - The machine ID
 * @param mutator - Function that receives the current processes array and returns
 *                  the updated array plus any result value to return to the caller
 * @returns The result value from the mutator
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

    // Strip undefined values from schedule blocks (Firestore rejects undefined)
    const cleanedProcesses = mutationResult.processes.map(cleanProcessForFirestore);

    transaction.update(configRef, { processes: cleanedProcesses });

    return mutationResult.result;
  });

  // Set configChangeFlag to notify agent (non-critical — agent polls anyway)
  try {
    const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await statusRef.update({ configChangeFlag: true });
  } catch {
    // Non-critical: agent polls config on its own cycle
  }

  return result;
}

/**
 * Strip undefined values and clean schedule blocks for Firestore compatibility.
 */
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

/* -------------------------------------------------------------------------- */
/*  Public-API helpers (Wave 2 — process-api)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Public-API view of a process config row. Same shape as `ProcessConfig`
 * but with `processId` (server-generated UUID) as the canonical id field.
 *
 * The legacy `id` field is preserved and kept in lockstep with `processId`
 * (both are the same value) so the agent (which still reads `id`) and the
 * existing admin route continue to work unchanged.
 */
export interface PublicProcessConfig extends ProcessConfig {
  processId: string;
}

/**
 * Transactional read-modify-write of `processes[]` with public-API guarantees:
 *
 * 1. Reads the current `processes[]` array inside a Firestore transaction.
 * 2. Lazily backfills `processId` on any row missing it (uses existing
 *    `id` if present, otherwise generates a new UUID).
 * 3. Calls the mutator with the normalized array.
 * 4. Validates the returned array has unique `name` values (case-sensitive
 *    exact match) — race-safe because the check runs inside the txn.
 * 5. Writes back the cleaned array; sets `configChangeFlag` on the status
 *    doc to nudge the agent.
 *
 * @throws ProcessConfigError(409, code: 'duplicate_process_name') if names collide
 * @throws ProcessConfigError(404) if config doc is missing
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

    // Lazy backfill: ensure every process has a `processId`.
    const normalized = (config.processes as ProcessConfig[]).map((p) => normalizeProcess(p));

    const mutationResult = fn(normalized);

    // Race-safe duplicate-name rejection (inside the transaction).
    assertUniqueNames(mutationResult.processes);

    // Strip undefined values + clean schedule blocks for Firestore compatibility.
    const cleaned = mutationResult.processes.map(cleanProcessForFirestore);

    transaction.update(configRef, { processes: cleaned });

    return mutationResult.result;
  });

  // Set configChangeFlag (non-critical — agent polls anyway).
  try {
    const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await statusRef.update({ configChangeFlag: true });
  } catch {
    // Ignore — agent polls config on its own cycle.
  }

  return result;
}

/**
 * Read the current process list with lazy `processId` backfill.
 *
 * Public API surfaces both the live status and the config; this is the
 * config side. Used by GET list + GET detail.
 *
 * Returns null if the config doc doesn't exist (machine has no config yet).
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

/**
 * Generate a new server-side processId. Centralized so every create path
 * uses the same scheme.
 */
export function generateProcessId(): string {
  return crypto.randomUUID();
}

/**
 * Normalise a stored process row: ensure `processId` exists, mirror it
 * to the legacy `id` field (and vice versa). Idempotent.
 */
function normalizeProcess(p: ProcessConfig): PublicProcessConfig {
  // Prefer existing processId; fall back to legacy id; otherwise generate.
  const processId = p.processId || p.id || generateProcessId();
  return {
    ...p,
    id: processId,
    processId,
  };
}

/**
 * Throws ProcessConfigError(409, 'duplicate_process_name') if any two
 * processes share the same `name`. Names are compared case-sensitive
 * (matches existing agent behaviour).
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
 * Find a process by its public-API id. Returns the index and the row,
 * or `null` if not found. Comparison is by `processId` field only —
 * legacy rows that have only `id` are normalized via `withProcessLock`
 * before lookup runs.
 */
export function findProcessIndex(
  processes: PublicProcessConfig[],
  processId: string
): number {
  return processes.findIndex((p) => p.processId === processId);
}
