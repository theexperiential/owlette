/**
 * Per-machine fan-out on top of `writeCommandFanOut` (`lib/commandLifecycle.ts`),
 * which only sends one identical body to a whole fleet. Here a
 * `builder(machineId)` varies the command per machine while keeping map-merge
 * semantics, lifecycle stamping, and an audit correlation id in `metadata`.
 *
 * Concurrency is bounded: a naive `Promise.all` over 500 machines fires 500
 * concurrent firestore writes. Batches of `FANOUT_CHUNK_SIZE` run sequentially,
 * parallel within a batch.
 *
 * Results preserve input order; a failing machine surfaces as `ok: false` and
 * never aborts the rest.
 */

import { writeCommandFanOut, type CommandData, type FanOutResult } from '@/lib/commandLifecycle';
import { getAdminDb } from '@/lib/firebase-admin';

/** Parallel writes per batch. Exported so tests assert against the real value. */
export const FANOUT_CHUNK_SIZE = 50;

/**
 * Per-machine builder output. `metadata` is reserved for the correlation id that
 * `fanOutToMachines` injects — put caller metadata elsewhere in `commandData`.
 */
export interface BuiltCommand {
  commandIdPrefix: string;
  commandData: CommandData;
}

export type CommandBuilder = (machineId: string) => BuiltCommand;

export interface FanOutToMachinesOptions {
  siteId: string;
  machineIds: readonly string[];
  builder: CommandBuilder;
  correlationId: string;
  /** Test seam; omitted in production. Shared by every per-machine write. */
  db?: ReturnType<typeof getAdminDb>;
  /** Test seam: command ids embed the timestamp, so this makes them predictable. */
  now?: () => number;
}

/** Fixed-size chunks; empty input → empty output, last chunk may be short. */
function chunk<T>(items: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    throw new Error('chunk: chunkSize must be > 0');
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * Fan a per-machine command across a fleet with bounded concurrency: each
 * `builder(machineId)` result is stamped and written to that machine's
 * `commands/pending`, in batches of `FANOUT_CHUNK_SIZE`.
 *
 * One result per machine, in input order. A throwing builder yields
 * `ok: false` without poisoning the rest of the fan-out.
 */
export async function fanOutToMachines(
  options: FanOutToMachinesOptions,
): Promise<FanOutResult[]> {
  const { siteId, machineIds, builder, correlationId, db, now } = options;

  if (!siteId) throw new Error('fanOutToMachines: siteId is required');
  if (!correlationId) throw new Error('fanOutToMachines: correlationId is required');
  if (typeof builder !== 'function') {
    throw new Error('fanOutToMachines: builder must be a function');
  }

  if (machineIds.length === 0) return [];

  // Resolve once so every batch shares one instance instead of re-looking-up.
  const resolvedDb = db ?? getAdminDb();

  const batches = chunk(machineIds, FANOUT_CHUNK_SIZE);
  const results: FanOutResult[] = [];

  for (const batch of batches) {
    // One call per machine because (prefix, commandData) varies; each touches a
    // single `pending` doc, so concurrency is bounded by batch size.
    const batchResults = await Promise.all(
      batch.map<Promise<FanOutResult>>(async (machineId) => {
        let built: BuiltCommand;
        try {
          built = builder(machineId);
        } catch (err) {
          return {
            machineId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        // Also written top-level by writeCommandFanOut for the audit pipeline,
        // but routing/replay reads `metadata` first.
        const existingMetadata =
          built.commandData.metadata && typeof built.commandData.metadata === 'object'
            ? (built.commandData.metadata as Record<string, unknown>)
            : {};
        const commandData: CommandData = {
          ...built.commandData,
          metadata: {
            ...existingMetadata,
            auditCorrelationId: correlationId,
          },
        };

        const [result] = await writeCommandFanOut(
          siteId,
          [machineId],
          built.commandIdPrefix,
          commandData,
          {
            db: resolvedDb,
            auditCorrelationId: correlationId,
            now,
          },
        );
        return result;
      }),
    );
    results.push(...batchResults);
  }

  return results;
}
