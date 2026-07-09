/**
 * Cortex turn store — stream doc lifecycle
 * (cortex-async-turns wave 1.1).
 *
 * A cortex chat turn (LLM loop + tool execution) now runs detached from the
 * HTTP request, so its live state must survive a dead stream. This module
 * owns the single durable record of an in-flight turn:
 *
 *   `chats/{chatId}/stream/current`
 *
 * One doc per chat — a new turn *replaces* the previous one (that overwrite
 * IS the supersede: the old runner's writes then no-op via turnId mismatch,
 * and clients watching the doc see the new running turn immediately).
 *
 * Lifecycle:
 *   1. `acquireTurnLock` — transactional claim. Rejects with `TurnActiveError`
 *      while another turn is running and fresh (heartbeat < TURN_STALE_MS),
 *      unless `supersede: true` (user sent a new message mid-turn) — then the
 *      old doc is flipped to a fresh `running` doc for the new turn. A stale
 *      running doc (runner killed by a deploy) is always claimable.
 *   2. `writeSnapshot` — throttled (≥SNAPSHOT_THROTTLE_MS apart) persistence
 *      of the in-progress assistant UIMessage, so a reattaching client can
 *      render the turn from Firestore alone.
 *   3. `touch` — heartbeat `updatedAt` bump during long tool polls (keeps the
 *      turn from being declared stale while no message content changes).
 *   4. `recordToolCommand` — `toolCallId → machineId → {commandId}` recovery
 *      index (nested so a site-wide tool call, which fans one toolCallId out to
 *      many machines, records EVERY machine's command instead of the last write
 *      clobbering the rest), so a later turn can splice in a real agent result
 *      by commandId even if this runner dies.
 *   5. `finishTurn` — terminal status (`complete` / `error` / `cancelled` /
 *      `superseded`).
 *
 * Every post-acquire write is guarded by a transactional turnId check and
 * NEVER throws into the runner — once superseded (or on any Firestore
 * hiccup), writes become silent no-ops and report `false`. Messages are
 * JSON-cloned before write because Firestore rejects nested `undefined`
 * (mirrors the client persist path in `web/hooks/useCortex.ts`).
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */

import crypto from 'crypto';
import { FieldPath, FieldValue, type Timestamp } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';

/* -------------------------------------------------------------------------- */
/*  types + constants                                                         */
/* -------------------------------------------------------------------------- */

export type TurnStatus = 'running' | 'complete' | 'error' | 'superseded' | 'cancelled';

export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;

/**
 * One recorded agent command for a tool call — the value stored at
 * `toolCommands[toolCallId][machineId]`. `machineId` is the map KEY now (a
 * site-wide tool call fans one toolCallId out to many machines), so the value
 * carries only the `commandId`.
 */
export interface TurnToolCommand {
  commandId: string;
}

/**
 * Recovery index: `toolCallId → machineId → { commandId }`. Nested so a
 * site-wide tool call (one toolCallId, N machines) records every machine's
 * command — a flat `toolCallId → command` map would let the last machine's
 * write clobber the rest (uncancellable + wrong-shape recovery).
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
 * The heartbeat's ownership signal, distinguishing a genuine loss from a
 * transient failure so a single Firestore blip can't kill a healthy turn:
 *   - `owned` : the doc is still ours + running (write landed).
 *   - `lost`  : the read SUCCEEDED and the turn genuinely no longer owns the
 *               doc (missing / turnId mismatch / already terminal) — a real
 *               supersede or stop. The runner must abort.
 *   - `error` : the transaction THREW (network blip, contention, outage) —
 *               ownership is INDETERMINATE; the runner keeps going (the next
 *               heartbeat re-checks) rather than aborting on a blip.
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

/* -------------------------------------------------------------------------- */
/*  internals                                                                 */
/* -------------------------------------------------------------------------- */

function streamRef(db: FirebaseFirestore.Firestore, chatId: string) {
  return db.collection('chats').doc(chatId).collection('stream').doc('current');
}

/**
 * Firestore rejects payloads containing nested `undefined`; a JSON round-trip
 * strips them (same pattern as the message serialization in useCortex.ts).
 */
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
 * Outcome of a turnId-guarded write. Distinguishes a genuine loss of ownership
 * from a transient transaction failure — collapsing both into `false` (the old
 * behavior) let a single network blip's `false` abort a healthy, still-owned
 * turn via the heartbeat:
 *   - `written`   : the doc still belongs to `turnId` AND is `running`; the
 *                   patch landed.
 *   - `not-owned` : the read SUCCEEDED and the doc is missing, superseded
 *                   (turnId mismatch), or already terminal — a live runner has
 *                   genuinely lost ownership (supersede OR stop/cancel).
 *   - `error`     : `runTransaction` THREW (blip / contention / outage). The
 *                   write did NOT land, but ownership is INDETERMINATE — this
 *                   is NOT genuine loss.
 */
type GuardedWriteOutcome = 'written' | 'not-owned' | 'error';

/**
 * Transactionally run `applyWrite` iff the stream doc still belongs to `turnId`
 * AND is still `running`, reporting the tri-state outcome above. NEVER throws —
 * post-acquire writes must be safe to fire from the runner without wrapping.
 *
 * NOTE: `acquireTurnLock`'s claim uses `txn.set` directly (not this helper),
 * so a fresh claim over a terminal doc is unaffected. `finishTurn` is a
 * running→terminal transition, so the doc is still `running` at read time and
 * the write lands; a second terminal write then reports `not-owned`
 * (terminal→terminal).
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
    // The transaction threw — a lost snapshot/heartbeat is recoverable and a
    // thrown error would kill the runner mid-turn. Report `error` (NOT
    // `not-owned`) so a transient blip is never mistaken for genuine loss.
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

/* -------------------------------------------------------------------------- */
/*  lifecycle api                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Claim the per-chat turn lock by (over)writing `stream/current` as a fresh
 * `running` doc. Rejects with `TurnActiveError` when another turn is running
 * with a fresh heartbeat, unless `meta.supersede` is set — the overwrite is
 * the supersede (the old runner's guarded writes no-op from then on). Stale
 * running docs (`updatedAt` older than TURN_STALE_MS — runner killed by a
 * deploy) are always claimable.
 *
 * Returns the PRIOR doc's `toolCommands` recovery index (or `null` when there
 * was no prior doc) read inside the same transaction — so the caller never has
 * to issue a separate pre-lock `get()` (which would be a TOCTOU read against
 * the overwrite this claim performs).
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
 * Persist the in-progress assistant UIMessage. Throttled to at most one
 * write per SNAPSHOT_THROTTLE_MS per chat; every accepted write bumps
 * `updatedAt`. No-ops (returns `false`) when throttled, superseded, or the
 * message can't be serialized — never throws.
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
  // A transient `error` is treated the same as a skip here — the snapshot is
  // best-effort and a later one recovers; only a landed write updates the
  // throttle window.
  if (outcome === 'written') lastSnapshotWriteAt.set(chatId, now);
  return outcome === 'written';
}

/**
 * Heartbeat: bump `updatedAt` so a long tool poll (no new message content)
 * doesn't get declared stale. Not throttled — callers already pace it.
 *
 * Returns the tri-state ownership signal (see `TurnOwnership`): the runner
 * aborts on `lost` (genuine supersede/stop) but NOT on `error` (a transient
 * Firestore failure must not kill a healthy, still-owned turn).
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
 * Record the `toolCallId → machineId → {commandId}` mapping the moment a tool
 * command is queued — the recovery index that lets a later turn splice in the
 * real agent result even if this runner dies. A site-wide tool call fans one
 * `toolCallId` out to many machines and calls this once per machine.
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
    // Use a FieldPath — NOT a dotted string `toolCommands.${toolCallId}.${machineId}`.
    // Real machineIds contain hyphens (e.g. 'INF-PROJECTION-WALL'), which are
    // invalid in Firestore's unquoted dotted field-path mini-language and would
    // throw at runtime. FieldPath segments are taken literally, and this nested
    // update replaces ONLY the `[toolCallId][machineId]` leaf — sibling machine
    // entries under the same toolCallId are preserved (no last-write-wins across
    // a site-wide fan-out).
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
  // Only a landed terminal write reports ownership to the caller. A transient
  // `error` here means the terminal write did NOT persist, so we must report
  // `false` — otherwise the runner would proceed to write its final message
  // array after a failed finalize (persist corruption). `not-owned` (a
  // supersede won the doc) is likewise `false`.
  const written = outcome === 'written';
  // Owned terminal transition: the turn is over — drop its throttle bookkeeping
  // so the map can't grow one stale entry per finished chat.
  if (written) lastSnapshotWriteAt.delete(chatId);
  return written;
}
