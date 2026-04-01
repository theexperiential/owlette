/**
 * Shared Process Config Mutation Helper
 *
 * Provides a transactional wrapper for mutating the process config array
 * stored at `config/{siteId}/machines/{machineId}`. Eliminates duplicated
 * boilerplate across process CRUD API endpoints.
 *
 * Uses Firestore Admin SDK transactions to prevent race conditions
 * (the client-side hooks in useFirestore.ts do non-transactional read-modify-write).
 */

import { getAdminDb } from '@/lib/firebase-admin';

export interface ProcessConfig {
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
  index?: number;
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

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
