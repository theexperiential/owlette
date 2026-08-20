/**
 * Hoot turn store — the durable record of an in-flight turn at
 * `chats/{chatId}/stream/current`. A turn runs detached from the HTTP request,
 * so its state must survive a dead stream.
 *
 * One doc per chat; a new turn OVERWRITES the previous one and that overwrite
 * IS the supersede — the old runner's guarded writes then no-op on turnId
 * mismatch and watchers see the new turn immediately.
 *
 * Every post-acquire write is guarded by a transactional turnId check and
 * never throws into the runner. Messages are JSON-cloned before write because
 * Firestore rejects nested `undefined` (mirrors `web/hooks/useHoot.ts`).
 *
 * Server-side only — never import this in client components.
 */

import crypto from 'crypto';
import { FieldPath, FieldValue, type Timestamp } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';

export type TurnStatus = 'running' | 'complete' | 'error' | 'superseded' | 'cancelled';

export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;

/** Value at `toolCommands[toolCallId][machineId]`; machineId is the key, so only the commandId is stored. */
export interface TurnToolCommand {
  commandId: string;
}

/**
 * Recovery index `toolCallId → machineId → { commandId }`. Nested so a
 * site-wide tool call (one toolCallId, N machines) records every machine —
 * a flat map would let the last write clobber the rest.
 */
export type TurnToolCommandMap = Record<string, Record<string, TurnToolCommand>>;

/** Shape of `chats/{chatId}/stream/current`. */
export interface TurnStreamDoc {
  status: TurnStatus;
  turnId: string;
  chatId: string;
  siteId: string;
  machineId: string;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  /** Serialized in-progress assistant UIMessage — null until the first snapshot. */
  message: UIMessage | null;
  toolCommands: TurnToolCommandMap;
  error?: string;
}

/**
 * Heartbeat ownership signal; tri-state so a Firestore blip can't kill a
 * healthy turn. `owned` = write landed. `lost` = read succeeded and the doc is
 * gone/mismatched/terminal (real supersede or stop) — runner must abort.
 * `error` = the transaction threw, ownership indeterminate — keep going.
 */
export type TurnOwnership = 'owned' | 'lost' | 'error';

export interface TurnLockMeta {
  turnId: string;
  siteId: string;
  machineId: string;
  /** Claim even while another turn is running fresh (new user message mid-turn). */
  supersede?: boolean;
}

/** A `running` doc whose heartbeat is older than this is a dead runner — claimable. */
export const TURN_STALE_MS = 45_000;

/** Minimum gap between snapshot writes per chat (Firestore write-volume cap). */
export const SNAPSHOT_THROTTLE_MS = 750;

/** Thrown by `acquireTurnLock` when a fresh turn is already running. */
export class TurnActiveError extends Error {
  readonly chatId: string;
  readonly activeTurnId: string;
  constructor(chatId: string, activeTurnId: string) {
    super(`a turn is already running for chat ${chatId}`);
    this.name = 'TurnActiveError';
    this.chatId = chatId;
    this.activeTurnId = activeTurnId;
  }
}

/** Generate a fresh turnId. Format: `turn_<24 url-safe chars>`. */
export function generateTurnId(): string {
  return `turn_${crypto.randomBytes(18).toString('base64url')}`;
}

function streamRef(db: FirebaseFirestore.Firestore, chatId: string) {
  return db.collection('chats').doc(chatId).collection('stream').doc('current');
}

/** Firestore rejects nested `undefined`; a JSON round-trip strips it (as useHoot.ts does). */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Per-chat timestamp of the last successful snapshot write (throttle state). */
const lastSnapshotWriteAt = new Map<string, number>();

/** Test-only: clear throttle state so suites don't bleed into each other. */
export function _resetThrottleForTests(): void {
  lastSnapshotWriteAt.clear();
}

/**
 * Outcome of a turnId-guarded write. Tri-state, not boolean: collapsing
 * `error` into `not-owned` let one network blip abort a healthy turn.
 * `written` = doc still ours and running. `not-owned` = read succeeded, doc
 * missing/mismatched/terminal. `error` = transaction threw, indeterminate.
 */
type GuardedWriteOutcome = 'written' | 'not-owned' | 'error';

/**
 * Transactionally run `applyWrite` iff the stream doc still belongs to `turnId`
 * AND is still `running`. Never throws — the runner fires these unwrapped.
 * `acquireTurnLock` bypasses this helper (`txn.set`) so a fresh claim over a
 * terminal doc still works; a second terminal write reports `not-owned`.
 */
async function guardedTurnWrite(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  applyWrite: (
    txn: FirebaseFirestore.Transaction,
    ref: FirebaseFirestore.DocumentReference,
  ) => void,
): Promise<GuardedWriteOutcome> {
  const ref = streamRef(db, chatId);
  try {
    return await db.runTransaction<GuardedWriteOutcome>(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return 'not-owned';
      const data = snap.data() ?? {};
      if (data.turnId !== turnId) return 'not-owned';
      if (data.status !== 'running') return 'not-owned';
      applyWrite(txn, ref);
      return 'written';
    });
  } catch {
    // `error`, never `not-owned`: a blip must not be read as genuine loss.
    return 'error';
  }
}

/** Object-form guarded update (+ an `updatedAt` bump). See `guardedTurnWrite`. */
function guardedTurnUpdate(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  patch: Record<string, unknown>,
): Promise<GuardedWriteOutcome> {
  return guardedTurnWrite(db, chatId, turnId, (txn, ref) => {
    txn.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Claim the per-chat turn lock by (over)writing `stream/current` as a fresh
 * `running` doc. Throws `TurnActiveError` when another turn is running with a
 * fresh heartbeat unless `meta.supersede`. Stale running docs (older than
 * TURN_STALE_MS — runner killed by a deploy) are always claimable.
 *
 * Returns the PRIOR `toolCommands` index, read in the same transaction: a
 * separate pre-lock `get()` would be a TOCTOU read against this overwrite.
 */
export async function acquireTurnLock(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  meta: TurnLockMeta,
): Promise<TurnToolCommandMap | null> {
  const ref = streamRef(db, chatId);

  let priorToolCommands: TurnToolCommandMap | null = null;

  await db.runTransaction(async (txn) => {
    // Reset per-retry so a transaction re-run reflects the latest read.
    priorToolCommands = null;
    const snap = await txn.get(ref);
    if (snap.exists) {
      const data = snap.data() ?? {};
      const prior = data.toolCommands;
      if (prior && typeof prior === 'object') {
        priorToolCommands = prior as TurnToolCommandMap;
      }
      if (!meta.supersede && data.status === 'running') {
        const updatedAt = data.updatedAt as Timestamp | undefined;
        const updatedMs =
          updatedAt && typeof updatedAt.toMillis === 'function' ? updatedAt.toMillis() : 0;
        if (Date.now() - updatedMs < TURN_STALE_MS) {
          throw new TurnActiveError(
            chatId,
            typeof data.turnId === 'string' ? data.turnId : 'unknown',
          );
        }
      }
    }

    txn.set(ref, {
      status: 'running' satisfies TurnStatus,
      turnId: meta.turnId,
      chatId,
      siteId: meta.siteId,
      machineId: meta.machineId,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      message: null,
      toolCommands: {},
    });
  });

  // Fresh turn — first snapshot should never be throttled by a prior turn.
  lastSnapshotWriteAt.delete(chatId);

  return priorToolCommands;
}

/**
 * Persist the in-progress assistant UIMessage; at most one write per
 * SNAPSHOT_THROTTLE_MS per chat. Returns `false` (never throws) when
 * throttled, superseded, or unserializable.
 */
export async function writeSnapshot(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  message: UIMessage,
): Promise<boolean> {
  const now = Date.now();
  const last = lastSnapshotWriteAt.get(chatId);
  if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return false;

  let cloned: UIMessage;
  try {
    cloned = jsonClone(message);
  } catch {
    // Unserializable snapshot (circular part) — skip rather than kill the turn.
    return false;
  }

  const outcome = await guardedTurnUpdate(db, chatId, turnId, { message: cloned });
  // Snapshots are best-effort; only a landed write moves the throttle window.
  if (outcome === 'written') lastSnapshotWriteAt.set(chatId, now);
  return outcome === 'written';
}

/**
 * Heartbeat: bump `updatedAt` so a long tool poll isn't declared stale. Not
 * throttled — callers pace it. Runner aborts on `lost`, never on `error`.
 */
export async function touch(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
): Promise<TurnOwnership> {
  const outcome = await guardedTurnUpdate(db, chatId, turnId, {});
  return outcome === 'written' ? 'owned' : outcome === 'not-owned' ? 'lost' : 'error';
}

/**
 * Record `toolCallId → machineId → {commandId}` when a tool command is queued,
 * so a later turn can splice in the real agent result if this runner dies.
 * Called once per machine for a site-wide fan-out.
 */
export async function recordToolCommand(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  toolCallId: string,
  commandId: string,
  machineId: string,
): Promise<boolean> {
  const outcome = await guardedTurnWrite(db, chatId, turnId, (txn, ref) => {
    // FieldPath, never a dotted string: machineIds contain hyphens (e.g.
    // 'INF-PROJECTION-WALL'), invalid in Firestore's dotted path syntax and a
    // runtime throw. Segments are literal, and only the [toolCallId][machineId]
    // leaf is replaced, so sibling machines survive a site-wide fan-out.
    txn.update(
      ref,
      new FieldPath('toolCommands', toolCallId, machineId),
      { commandId } satisfies TurnToolCommand,
      'updatedAt',
      FieldValue.serverTimestamp(),
    );
  });
  return outcome === 'written';
}

/**
 * Mark the turn terminal. `error` is only stamped when provided (typically
 * with `status: 'error'`). No-ops when the turn was superseded mid-flight.
 */
export async function finishTurn(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
  status: TerminalTurnStatus,
  error?: string,
): Promise<boolean> {
  const outcome = await guardedTurnUpdate(db, chatId, turnId, {
    status,
    ...(error !== undefined ? { error } : {}),
  });
  // `error` must report false too: the terminal write did not persist, and the
  // runner writing its final message array after a failed finalize corrupts it.
  const written = outcome === 'written';
  // Turn is over — drop throttle state so the map can't leak one entry per chat.
  if (written) lastSnapshotWriteAt.delete(chatId);
  return written;
}
