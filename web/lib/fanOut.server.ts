/**
 * Fan-out helper (security-boundary-migration wave 2.2).
 *
 * Layered on top of `writeCommandFanOut` from wave 1.6
 * (`web/lib/commandLifecycle.ts`). The 1.6 primitive sends the SAME stamped
 * command body to every machine in a fleet; this helper lets the caller
 * vary the command per machine via a `builder(machineId)` callback, while
 * still benefiting from canonical map-merge semantics, lifecycle stamping,
 * and an audit correlation id woven into every entry's `metadata`.
 *
 * It also bounds concurrency. `writeCommandFanOut` is one map-merge per
 * machine — for a 500-machine deployment a naive `Promise.all` would
 * detonate 500 concurrent writes against firestore, hammering quotas and
 * producing pathological tail latencies. We instead chunk the input into
 * batches of `FANOUT_CHUNK_SIZE` and process them sequentially; within
 * each batch the writes still run in parallel.
 *
 * Each per-machine call to `writeCommandFanOut` is independent (siteId is
 * shared, but the prefix + commandData come from `builder(machineId)`), so
 * results are merged into a single `FanOutResult[]` preserving input order.
 * One bad machine never aborts the rest — failures are caught per-target
 * and surfaced through `ok: false` + `error`.
 */

import { writeCommandFanOut, type CommandData, type FanOutResult } from '@/lib/commandLifecycle';
import { getAdminDb } from '@/lib/firebase-admin';

/**
 * Maximum number of per-machine writes issued in parallel inside one
 * batch. Exported so tests can verify the chunking arithmetic against the
 * production constant. Sequential between batches; parallel within.
 */
export const FANOUT_CHUNK_SIZE = 50;

/**
 * Per-machine builder output. The caller decides the command's `type`,
 * payload, and the `commandIdPrefix` used to synthesize the per-machine
 * `commandId` inside `writeCommandFanOut`. The correlation id is added by
 * `fanOutToMachines` itself — builders should not duplicate it.
 *
 * `metadata` is reserved for the correlation id injection. If the caller
 * wants to attach their own metadata, they should put it inside
 * `commandData` under a different key — wave 2.2 owns the `metadata` slot
 * for audit threading.
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
  /**
   * Inject a Firestore instance — tests pass a mock; production callers
   * omit this and the helper uses `getAdminDb()`. Forwarded verbatim into
   * each `writeCommandFanOut` call so all per-machine writes share one db.
   */
  db?: ReturnType<typeof getAdminDb>;
  /**
   * Override the wall-clock `now` — unit tests use this for determinism.
   * Forwarded into `writeCommandFanOut` so the synthesized command ids
   * (which embed the timestamp) are predictable.
   */
  now?: () => number;
}

/**
 * Split an array into fixed-size chunks. Pure utility — no allocations
 * beyond the chunk arrays themselves. Empty input → empty output (zero
 * batches). Last chunk may be shorter than `chunkSize`.
 */
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
 * Fan a per-machine command across a fleet with bounded concurrency.
 *
 * For each machine, `builder(machineId)` produces a `{ commandIdPrefix,
 * commandData }` pair; the helper stamps the command (lifecycle fields +
 * `auditCorrelationId` inside `metadata`) and writes it to that machine's
 * `commands/pending` doc via `writeCommandFanOut`. Per-machine calls are
 * batched in groups of `FANOUT_CHUNK_SIZE`, processed sequentially across
 * batches and in parallel within a batch.
 *
 * Returns one result per input machine in the same order. A failed
 * `builder(...)` call surfaces as `ok: false` with the thrown error
 * message — the failing machine does not poison the rest of the fan-out.
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

  // Resolve the db once so every batch shares the same Firestore instance.
  // Without this, each `writeCommandFanOut` call would re-resolve via
  // `getAdminDb()` and tests that omit `db` would still work, but we'd
  // pay an unnecessary lookup per batch.
  const resolvedDb = db ?? getAdminDb();

  const batches = chunk(machineIds, FANOUT_CHUNK_SIZE);
  const results: FanOutResult[] = [];

  for (const batch of batches) {
    // Within a batch, every machine gets its own `writeCommandFanOut` call
    // because the (prefix, commandData) pair varies per machine. Each call
    // hits exactly one `pending` doc, so concurrency here is bounded by
    // batch size, not by some unrelated writeCommandFanOut internal.
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

        // Inject the audit correlation id under `metadata`. The 1.6 helper
        // also writes `auditCorrelationId` as a top-level entry field
        // (separate convention, kept for backward compat with the audit
        // pipeline), but the documented per-command shape carries
        // operator-visible context inside `metadata` — that's where
        // routing/replay code looks first.
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
