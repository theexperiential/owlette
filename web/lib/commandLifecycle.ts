/**
 * Command lifecycle helpers (security-boundary-migration wave 1.6).
 *
 * The agent listens to a SINGLE document at
 * `sites/{siteId}/machines/{machineId}/commands/pending` whose fields are a
 * map of `{ [commandId]: { type, status, ... } }`. Every server-issued
 * command is stamped with `createdAt` + `expiresAt` and merged into that
 * doc by command id.
 *
 * `stampCommand` adds the lifecycle fields to a command entry. `createdAt`
 * uses `FieldValue.serverTimestamp()` (legal inside nested map fields under
 * a top-level `set`/`update`; only forbidden inside array elements). The
 * 24h `expiresAt` is a wall-clock `Timestamp` so it survives field-level
 * reads without needing a sentinel resolver.
 *
 * `writeCommandFanOut` performs the canonical map-merge write across n
 * machines using the admin SDK. Each machine's `pending` doc receives one
 * field at the top level: `{ [commandId]: stampedCommandData }`. Concurrent
 * fan-out writes to DIFFERENT machines are independent; concurrent writes
 * to the SAME machine merge by Firestore field semantics (last-write-wins
 * per command id, but unique command ids never collide in practice because
 * the prefix carries `Date.now()` and the machine id).
 *
 * **Cleanup is not implemented in milestone a** — see
 * `dev/active/security-boundary-migration/reference/command-lifecycle.md`
 * for why and how it ships in milestone b.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

/** 24h expiry — matches the agent's longest-running command allowance. */
export const COMMAND_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Shape of a single command entry as written into the `pending` map. The
 * caller controls all command-specific fields (`type`, `installer_url`,
 * `deployment_id`, etc.); `stampCommand` only adds the lifecycle metadata.
 *
 * `Record<string, unknown>` is intentional — every command type has its own
 * payload shape and the helpers here are payload-agnostic. Stricter typing
 * lives at each action core (e.g. `executeMachineCommand` in wave 3.1).
 */
export type CommandData = Record<string, unknown>;

/**
 * A `CommandData` after `stampCommand` has run. The two lifecycle fields
 * are guaranteed present; `auditCorrelationId` is present when callers
 * passed one through (wave 2.2 fan-out always does).
 */
export interface StampedCommandData extends CommandData {
  createdAt: FieldValue;
  expiresAt: Timestamp;
  auditCorrelationId?: string;
}

/**
 * Per-machine result from a fan-out write. `commandId` is the synthesized
 * id this machine's entry was written under (`${commandIdPrefix}_${machineId}_${ts}`).
 * `error` is the human-readable message from the rejected write — stack
 * traces are not propagated to keep the audit log compact.
 */
export interface FanOutResult {
  machineId: string;
  ok: boolean;
  commandId?: string;
  error?: string;
}

export interface StampCommandOptions {
  /** Optional correlation id from `authorizedHandler`/`systemInvoker`. */
  auditCorrelationId?: string;
  /** Override the wall-clock `now` — unit tests use this for determinism. */
  now?: () => number;
}

/**
 * Add lifecycle fields to a command entry. Returns a fresh object — does
 * not mutate the caller's input. If `commandData` already carries a
 * `createdAt` or `expiresAt` (e.g. a caller pre-stamped, or we're replaying
 * an idempotent retry), the lifecycle fields here OVERWRITE — the helper
 * is the authoritative source.
 */
export function stampCommand(
  commandData: CommandData,
  options: StampCommandOptions = {},
): StampedCommandData {
  const now = options.now ? options.now() : Date.now();
  const stamped: StampedCommandData = {
    ...commandData,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + COMMAND_EXPIRY_MS),
  };
  if (options.auditCorrelationId) {
    stamped.auditCorrelationId = options.auditCorrelationId;
  }
  return stamped;
}

export interface WriteCommandFanOutOptions extends StampCommandOptions {
  /**
   * Inject a Firestore instance — tests pass a mock; production callers
   * omit this and the helper uses `getAdminDb()`.
   */
  db?: ReturnType<typeof getAdminDb>;
}

/**
 * Map-merge write of a single command across n machines. Each target
 * receives the SAME stamped command body under a unique per-machine
 * `commandId` of the form `${commandIdPrefix}_${sanitizedMachineId}_${ts}`
 * (matching the legacy hook-side fan-out scheme so the agent's listener
 * sees identical keys to today's writes).
 *
 * Returns one `FanOutResult` per input machine. Failures are caught
 * per-machine — one rejected write does not abort the others.
 */
export async function writeCommandFanOut(
  siteId: string,
  machineIds: readonly string[],
  commandIdPrefix: string,
  commandData: CommandData,
  options: WriteCommandFanOutOptions = {},
): Promise<FanOutResult[]> {
  if (!siteId) throw new Error('writeCommandFanOut: siteId is required');
  if (!commandIdPrefix) throw new Error('writeCommandFanOut: commandIdPrefix is required');

  const db = options.db ?? getAdminDb();
  const stamped = stampCommand(commandData, {
    auditCorrelationId: options.auditCorrelationId,
    now: options.now,
  });
  // Single timestamp shared across the fan-out keeps all per-machine
  // command ids monotonically related to one logical batch — useful when
  // the reconciler (wave 2.4) replays.
  const batchTs = options.now ? options.now() : Date.now();

  return Promise.all(
    machineIds.map<Promise<FanOutResult>>(async (machineId) => {
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `${commandIdPrefix}_${sanitizedMachineId}_${batchTs}`;
      try {
        const pendingRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');
        await pendingRef.set({ [commandId]: stamped }, { merge: true });
        return { machineId, ok: true, commandId };
      } catch (err) {
        return {
          machineId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
