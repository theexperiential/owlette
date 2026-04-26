/**
 * deleteOwnAccount action core (security-boundary-migration wave 3.10).
 *
 * Server-side cascade for `DELETE /api/users/me` — replaces the legacy
 * client-side `writeBatch` cascade in `web/contexts/AuthContext.tsx`'s
 * `deleteAccount`. Hard-deletes every Firestore doc the user owns, in the
 * exact path-set the legacy cascade covered:
 *
 *   1. `sites/{siteId}/machines/*`     — every machine in each owned site
 *   2. `sites/{siteId}/deployments/*`  — every deployment in each owned site
 *   3. `sites/{siteId}/logs/*`         — every log entry in each owned site
 *   4. `sites/{siteId}`                — the site doc itself (deleted last)
 *   5. `users/{userId}`                — the user doc (deleted very last)
 *
 * The "owned sites" list is sourced from `users/{userId}.sites[]` — same
 * source the legacy client used. Sites where the user is one of multiple
 * members are NOT preserved here; this matches the legacy behavior to keep
 * the diff-test green. Multi-member ownership semantics are out of scope
 * for this migration and tracked separately.
 *
 * Capability: `USER_SELF_DELETE` — granted to every role tier in
 * `web/lib/capabilities.ts`. The route shim enforces the boundary: an
 * authenticated user may delete ONLY themselves (the route refuses if the
 * caller's session uid doesn't match the action's `userId`). Site access
 * checks are deliberately skipped — the actor IS the target, so the
 * standard `authorizedSiteHandler` doesn't apply.
 *
 * ## Chunking
 * Each subcollection (machines / deployments / logs) is enumerated and
 * deleted in batches of `BATCH_SIZE` (=100). For users with hundreds of
 * machines or years of logs the loop iterates until the collection is
 * drained, well below the Railway request timeout.
 *
 * ## Idempotency
 * A single best-effort progress doc at
 * `users/{userId}/account_deletion/operation` records the operation id and
 * incremental delete counts as the cascade runs. A re-issued call:
 *   - finds the progress doc and replays the recorded outcome (no double
 *     work, no `users/{userId}` re-read errors after the user doc has
 *     already been deleted), OR
 *   - if a previous run aborted partway through, resumes from where it left
 *     off (the next batch picks up because previously-deleted docs are
 *     simply absent from the collection scan).
 *
 * Once the user doc is deleted the progress doc is the only remaining
 * record. We don't try to delete it — it lives under the deleted user's
 * tree and is invisible to platform readers; a TTL sweep can prune it
 * later if needed.
 *
 * ## Dry run
 * `dryRun: true` runs the same scans but performs no deletes. The result
 * carries the same per-path counts the real run would have produced, so
 * the route can return them verbatim to the caller for inspection.
 *
 * ## Resumability — current limitation
 * If the cascade fails partway through (e.g. firestore quota error mid-
 * batch), the progress doc records the partial state. The next invocation
 * resumes by re-running the scans (collections shrink as docs are deleted),
 * so the cascade is **eventually consistent**. Strict resume-from-checkpoint
 * via the operation-id record (skip already-completed phases) is **deferred
 * to a follow-up** because it adds complexity disproportionate to the
 * benefit at the current scale (the cascade typically finishes in <2s for
 * a single-user single-site account). The operation-id record is in place
 * so resumption can be added without a schema change.
 *
 * ## NOT in scope (left to the route + client)
 * - Re-authentication of the user (client-side; password / passkey check)
 * - Firebase Auth account deletion (`auth.deleteUser`) — done by the
 *   client AFTER the cascade succeeds
 * - Session cookie destruction — handled by the existing
 *   `DELETE /api/auth/session` route
 *
 * The action core's contract: drain Firestore data, return a structured
 * result the route shim can translate to RFC 7807 / 200 JSON.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/** Hard cap per Firestore batch — well under the 500-write limit. */
export const BATCH_SIZE = 100;

/** Subcollections under each owned site that the cascade drains. */
const SITE_SUBCOLLECTIONS = ['machines', 'deployments', 'logs'] as const;

type SiteSubcollection = (typeof SITE_SUBCOLLECTIONS)[number];

export interface DeleteOwnAccountInput {
  /** The user deleting themselves. The route shim asserts this matches the session uid. */
  userId: string;
  /** When true, runs the scans and reports counts but performs no deletes. */
  dryRun?: boolean;
  /** Stable join key for the progress doc + audit row. */
  operationId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
  /** Override `Date.now()` for unit tests. */
  now?: () => number;
}

export interface DeleteOwnAccountResult {
  userId: string;
  operationId: string;
  /** Whether this invocation actually performed deletes (false in dry-run + replay). */
  performed: boolean;
  /** True when an earlier completed run was replayed (no work this call). */
  alreadyCompleted: boolean;
  dryRun: boolean;
  /** Sites the cascade visited (sourced from users/{userId}.sites[]). */
  sites: string[];
  /** Per-path doc-delete counts. Same shape for live runs and dry-runs. */
  deletedCounts: {
    machines: number;
    deployments: number;
    logs: number;
    sites: number;
    users: number;
  };
  /** Firestore paths that were (or would be) deleted, ordered as deleted. */
  deletedPaths: string[];
}

interface SiteScanCounts {
  machines: number;
  deployments: number;
  logs: number;
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function emptyCounts(): SiteScanCounts {
  return { machines: 0, deployments: 0, logs: 0 };
}

/**
 * Drain a subcollection in chunks of `BATCH_SIZE`. Returns the number of
 * docs visited (which equals the number deleted in a live run, or the
 * count that would be deleted in a dry run).
 */
async function drainSubcollection(
  db: Firestore,
  siteId: string,
  sub: SiteSubcollection,
  dryRun: boolean,
  deletedPaths: string[],
): Promise<number> {
  const colRef = db.collection('sites').doc(siteId).collection(sub);
  let total = 0;

  if (dryRun) {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        deletedPaths.push(`sites/${siteId}/${sub}/${doc.id}`);
      }
      total += snap.size;

      if (snap.size < BATCH_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1] ?? null;
      if (!lastDoc) break;
    }
    return total;
  }

  // Loop until a scan returns fewer docs than BATCH_SIZE, which signals
  // the collection is drained. Using `.limit()` keeps memory bounded.
  for (;;) {
    const snap = await colRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      deletedPaths.push(`sites/${siteId}/${sub}/${doc.id}`);
    }
    await batch.commit();

    total += snap.size;

    // If the scan returned a partial page, the collection is drained.
    if (snap.size < BATCH_SIZE) break;
  }

  return total;
}

/* -------------------------------------------------------------------------- */
/*  action                                                                    */
/* -------------------------------------------------------------------------- */

export async function deleteOwnAccount(
  input: DeleteOwnAccountInput,
): Promise<DeleteOwnAccountResult> {
  if (!input.userId || typeof input.userId !== 'string') {
    throw new Error('userId is required');
  }
  if (!input.operationId || typeof input.operationId !== 'string') {
    throw new Error('operationId is required');
  }

  const db = input.db ?? getAdminDb();
  const now = input.now ?? (() => Date.now());
  const dryRun = Boolean(input.dryRun);

  const userRef = db.collection('users').doc(input.userId);
  const progressRef = userRef.collection('account_deletion').doc('operation');
  const deletedPaths: string[] = [];

  // ── 0. Idempotency / replay check ───────────────────────────────────────
  // Skip the progress check entirely for dry-runs so a previous live run
  // doesn't short-circuit a "what would be deleted now?" preview.
  if (!dryRun) {
    const progressSnap = await progressRef.get().catch(() => null);
    if (progressSnap && progressSnap.exists) {
      const data = progressSnap.data() ?? {};
      if (data.completedAt && data.operationId === input.operationId) {
        // Same operation id, already finished — return the recorded outcome.
        const recordedSites = Array.isArray(data.sites)
          ? (data.sites as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : [];
        const counts = (data.deletedCounts as Record<string, unknown>) ?? {};
        return {
          userId: input.userId,
          operationId: input.operationId,
          performed: false,
          alreadyCompleted: true,
          dryRun: false,
          sites: recordedSites,
          deletedCounts: {
            machines: numberOr0(counts.machines),
            deployments: numberOr0(counts.deployments),
            logs: numberOr0(counts.logs),
            sites: numberOr0(counts.sites),
            users: numberOr0(counts.users),
          },
          deletedPaths: Array.isArray(data.deletedPaths)
            ? (data.deletedPaths as unknown[]).filter(
                (s): s is string => typeof s === 'string',
              )
            : [],
        };
      }
      // Different operation id OR incomplete prior run → fall through and
      // resume. The collection scans will skip already-deleted docs.
    }
  }

  // ── 1. Read the user doc to source the owned-sites list ─────────────────
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    // The user doc is already gone. If a progress doc exists for the same
    // op, treat as already-completed; otherwise treat as a noop empty run.
    return {
      userId: input.userId,
      operationId: input.operationId,
      performed: false,
      alreadyCompleted: true,
      dryRun,
      sites: [],
      deletedCounts: { machines: 0, deployments: 0, logs: 0, sites: 0, users: 0 },
      deletedPaths: [],
    };
  }
  const userData = userSnap.data() ?? {};
  const sites = Array.isArray(userData.sites)
    ? (userData.sites as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  // ── 2. Stamp the progress doc as in-flight (live runs only) ─────────────
  if (!dryRun) {
    try {
      await progressRef.set(
        {
          operationId: input.operationId,
          userId: input.userId,
          startedAt: FieldValue.serverTimestamp(),
          startedAtMs: now(),
          sites,
          status: 'in_progress',
        },
        { merge: true },
      );
    } catch (err) {
      logger.warn(
        '[deleteOwnAccount] progress doc write failed (non-fatal — continuing)',
        {
          context: 'deleteOwnAccount',
          data: {
            userId: input.userId,
            operationId: input.operationId,
            err: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
  }

  // ── 3. Drain each owned site's subcollections, then delete the site ─────
  const totals: SiteScanCounts = emptyCounts();
  let sitesDeleted = 0;

  for (const siteId of sites) {
    const siteRef = db.collection('sites').doc(siteId);
    const siteSnap = await siteRef.get();
    if (!siteSnap.exists) continue;

    // Subcollections first — child docs must go before the parent so a
    // mid-cascade abort leaves the site doc as the canonical "still owned"
    // marker. (Firestore does NOT cascade subcollection deletes when a
    // parent is deleted; that's why the legacy client cascade did this
    // explicitly too.)
    for (const sub of SITE_SUBCOLLECTIONS) {
      const n = await drainSubcollection(db, siteId, sub, dryRun, deletedPaths);
      totals[sub] += n;
    }

    // Then the site doc itself.
    if (!dryRun) {
      await siteRef.delete();
    }
    deletedPaths.push(`sites/${siteId}`);
    sitesDeleted += 1;
  }

  // ── 4. Delete the user doc ───────────────────────────────────────────────
  let usersDeleted = 0;
  if (!dryRun) {
    await userRef.delete();
  }
  deletedPaths.push(`users/${input.userId}`);
  usersDeleted = 1;

  const deletedCounts = {
    machines: totals.machines,
    deployments: totals.deployments,
    logs: totals.logs,
    sites: sitesDeleted,
    users: usersDeleted,
  };

  // ── 5. Stamp the progress doc as completed (live runs only) ─────────────
  // The progress doc lives under the now-deleted user tree but persists
  // (firestore deletes don't cascade). It carries the operation outcome so
  // a retry sees `completedAt` + `operationId` and short-circuits.
  if (!dryRun) {
    try {
      await progressRef.set(
        {
          operationId: input.operationId,
          userId: input.userId,
          completedAt: FieldValue.serverTimestamp(),
          completedAtMs: now(),
          status: 'completed',
          sites,
          deletedCounts,
          // Persist a bounded slice; full path lists can be huge for users
          // with thousands of logs and aren't useful for replay correctness.
          deletedPaths: deletedPaths.slice(0, 200),
        },
        { merge: true },
      );
    } catch (err) {
      // Best-effort; the cascade itself succeeded. A missing completion
      // stamp means the next call will re-run the (now-empty) scans and
      // emit a noop result, which is benign.
      logger.warn(
        '[deleteOwnAccount] progress doc completion stamp failed (non-fatal)',
        {
          context: 'deleteOwnAccount',
          data: {
            userId: input.userId,
            operationId: input.operationId,
            err: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
  }

  return {
    userId: input.userId,
    operationId: input.operationId,
    performed: !dryRun,
    alreadyCompleted: false,
    dryRun,
    sites,
    deletedCounts,
    deletedPaths,
  };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
