/**
 * One-shot tier-3 approval ledger.
 *
 * An approval decision lives only in client React state until the resumed turn
 * persists it, so a reload (or second tab) during the approve→execute window can
 * re-present the approve button and dispatch the same tool twice. The ledger
 * makes consumption atomic: the first turn to resume an approved tool call
 * claims `chats/{chatId}/approvals/{toolCallId}` with a Firestore `create()`
 * (atomic ALREADY_EXISTS on conflict) BEFORE anything is dispatched; every
 * later turn sees `already-consumed` and rewrites the part to a terminal state
 * instead of executing (repairMessages.applyApprovalConsumption).
 *
 * Deliberately NOT built on lib/idempotency.ts — its read-before-save race
 * (OWL-07) is the exact bug class this ledger exists to close.
 *
 * Failure policy: a claim that errs indeterminately is retried once, then
 * FAILS OPEN as 'claimed' (logged). A Firestore blip must not block a
 * legitimate approval; double execution additionally requires a concurrent
 * duplicate turn in that same blip. Mirrors turnStore.touch's tri-state
 * philosophy of never escalating an indeterminate error into a user-visible
 * failure.
 *
 * Docs are ~100 bytes, created only when a human approves a tier-3 tool, and
 * carry `expiresAt` for a future sweep; like `stream/current` they are
 * orphaned by client-side chat deletion (pre-existing, tracked in
 * dev/active/repo-cleanup-followups). No firestore.rules change: the
 * subcollection has no match block, so clients are default-denied.
 *
 * Server-side only.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { sanitizeForLog } from '@/lib/logSanitize';

export type ApprovalClaim = 'claimed' | 'already-consumed';

/** Ledger docs become sweepable after 30 days — far beyond any turn's life. */
const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * Atomically claim an approved tool call for execution by `turnId`.
 * 'claimed' → this turn owns the dispatch; 'already-consumed' → another turn
 * got there first and the caller must not execute.
 */
export async function claimApproval(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  toolCallId: string,
  meta: { turnId: string },
): Promise<ApprovalClaim> {
  const ref = db
    .collection('chats')
    .doc(chatId)
    .collection('approvals')
    .doc(toolCallId);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ref.create({
        turnId: meta.turnId,
        claimedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + APPROVAL_TTL_MS),
      });
      return 'claimed';
    } catch (error) {
      if (isAlreadyExists(error)) return 'already-consumed';
      if (attempt === 1) {
        console.error(
          `[hoot] approval claim failed twice for chat ${sanitizeForLog(chatId)} tool ${sanitizeForLog(toolCallId)} — failing open:`,
          error,
        );
        return 'claimed';
      }
    }
  }
  // Unreachable; the loop always returns.
  return 'claimed';
}
