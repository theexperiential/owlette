/**
 * Scheduled hoot follow-ups — the durable "check back on this later" record at
 * `cortex-followups/{id}`.
 *
 * The collection keeps its `cortex` spelling: the name is data at rest and is
 * already pinned by `firestore.rules` (WIRE_NAMES class A). Everything a human
 * reads says hoot.
 *
 * `status` is the whole concurrency story. A follow-up is written `scheduled`
 * and leaves that state exactly once — the sweep's transactional flip to
 * `fired` IS the claim, so overlapping sweeps can never dispatch the same turn
 * twice, and a cancel that loses the race finds a non-`scheduled` doc. No other
 * field is ever rewritten after creation, which is why the claim needs no
 * re-read of `runAt`.
 *
 * Clients may READ their own follow-ups (rules); every write goes through the
 * Admin SDK here.
 *
 * Server-side only — never import this in client components.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';

/** Data at rest — see the WIRE_NAMES note above before renaming. */
export const FOLLOWUPS_COLLECTION = 'cortex-followups';

export type FollowupStatus = 'scheduled' | 'fired' | 'cancelled' | 'failed';

/** Shape of `cortex-followups/{id}` as stored. */
export interface FollowupDoc {
  chatId: string;
  siteId: string;
  /** `__site__` for a site-wide chat, mirroring the runner's sentinel. */
  machineId: string;
  userId: string;
  note: string;
  runAt: unknown;
  /** A command whose completion fires this follow-up early. */
  watchCommandId?: string;
  status: FollowupStatus;
  createdAt: unknown;
  firedAt?: unknown;
  /** Why the fire path gave up, when `status` is `failed`. */
  turnError?: string;
}

export interface ScheduleFollowupInput {
  chatId: string;
  siteId: string;
  machineId: string;
  userId: string;
  note: string;
  runAt: Date;
  watchCommandId?: string;
}

export interface ScheduledFollowup {
  id: string;
  runAt: Date;
}

/** A follow-up as callers outside this module see it — timestamps flattened to ms. */
export interface FollowupSummary {
  id: string;
  chatId: string;
  siteId: string;
  machineId: string;
  userId: string;
  note: string;
  runAtMs: number | null;
  status: FollowupStatus;
  watchCommandId?: string;
  turnError?: string;
}

/** Why {@link cancelFollowup} did nothing, so callers can pick a status code. */
export type CancelFollowupOutcome = 'cancelled' | 'not_found' | 'forbidden' | 'not_scheduled';

/** Default ceiling on {@link listChatFollowups}; a chat holds a handful at most. */
const LIST_LIMIT = 50;

export function followupsCollection(db: Firestore) {
  return db.collection(FOLLOWUPS_COLLECTION);
}

function toSummary(id: string, data: FollowupDoc): FollowupSummary {
  return {
    id,
    chatId: data.chatId,
    siteId: data.siteId,
    machineId: data.machineId,
    userId: data.userId,
    note: data.note,
    runAtMs: timestampToMs(data.runAt),
    status: data.status,
    ...(data.watchCommandId ? { watchCommandId: data.watchCommandId } : {}),
    ...(data.turnError ? { turnError: data.turnError } : {}),
  };
}

/**
 * Write a new `scheduled` follow-up. `runAt` is stored as given — the caller
 * owns the delay/at arithmetic and its bounds.
 */
export async function scheduleFollowup(
  db: Firestore,
  input: ScheduleFollowupInput,
): Promise<ScheduledFollowup> {
  const doc: FollowupDoc = {
    chatId: input.chatId,
    siteId: input.siteId,
    machineId: input.machineId,
    userId: input.userId,
    note: input.note,
    runAt: input.runAt,
    status: 'scheduled',
    createdAt: FieldValue.serverTimestamp(),
    ...(input.watchCommandId ? { watchCommandId: input.watchCommandId } : {}),
  };

  const ref = await followupsCollection(db).add(doc);
  return { id: ref.id, runAt: input.runAt };
}

/**
 * Cancel a follow-up on its owner's behalf. Transactional so a cancel racing
 * the sweep's claim loses cleanly (`not_scheduled`) rather than cancelling a
 * turn that is already dispatching.
 *
 * Ownership is checked here, not at the call site: the Admin SDK bypasses
 * rules, so this is the only gate between a chat tool and someone else's
 * follow-up.
 */
export async function cancelFollowup(
  db: Firestore,
  followupId: string,
  options: { userId: string },
): Promise<CancelFollowupOutcome> {
  const ref = followupsCollection(db).doc(followupId);

  return db.runTransaction<CancelFollowupOutcome>(async (txn) => {
    const snapshot = await txn.get(ref);
    const data = snapshot.exists ? (snapshot.data() as FollowupDoc | undefined) : undefined;
    if (!data) return 'not_found';
    if (data.userId !== options.userId) return 'forbidden';
    if (data.status !== 'scheduled') return 'not_scheduled';

    txn.update(ref, { status: 'cancelled' satisfies FollowupStatus });
    return 'cancelled';
  });
}

/**
 * Follow-ups on one chat, soonest first. Defaults to `scheduled` — the only
 * status with anything left to show — so the composite index this needs is
 * `(chatId, status, runAt)`.
 */
export async function listChatFollowups(
  db: Firestore,
  chatId: string,
  options?: { status?: FollowupStatus; limit?: number },
): Promise<FollowupSummary[]> {
  const snapshot = await followupsCollection(db)
    .where('chatId', '==', chatId)
    .where('status', '==', options?.status ?? 'scheduled')
    .orderBy('runAt', 'asc')
    .limit(options?.limit ?? LIST_LIMIT)
    .get();

  return snapshot.docs.map((doc) => toSummary(doc.id, doc.data() as FollowupDoc));
}
