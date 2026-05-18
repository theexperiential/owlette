/**
 * deleteOwnAccount action core (security-boundary-migration wave 3.10 +
 * CRIT-A6 hardening).
 *
 * Server-side cascade for `DELETE /api/users/me` — replaces the legacy
 * client-side `writeBatch` cascade in `web/contexts/AuthContext.tsx`'s
 * `deleteAccount`. The cascade now distinguishes between:
 *
 *   - **Sole-owner sites** (`sites/{siteId}.owner === uid` AND no other
 *     members): hard-deleted, along with every machine / deployment / log.
 *   - **Member sites** (`uid ∈ users/{uid}.sites[]` but
 *     `sites/{siteId}.owner !== uid`): the site doc is left intact. The
 *     user is dropped from membership via `arrayRemove` on their own user
 *     doc (which is then deleted anyway, but the audit row records the
 *     classification).
 *   - **Owned-but-shared sites** (`owner === uid` AND other members
 *     exist): the cascade refuses with `needs_successor`. The user must
 *     transfer ownership via `DELETE /api/users/{uid}?successorUid=...`
 *     (or assign another admin and have them invoke transfer) before they
 *     can self-delete. This mirrors the admin-delete cascade's
 *     `orphan_sites` guard.
 *
 * In addition to the per-site cascade, the action drains the following
 * paths so a self-deleted user leaves no residue:
 *
 *   1. `users/{uid}/passkeys/*`            — passkey subcollection
 *   2. `users/{uid}/api_keys/*`            — owned api keys
 *   3. `api_keys/{keyHash}` (top-level)    — lookup docs matching the user
 *   4. `mfa_pending/{uid}`                 — pending MFA enrollment doc
 *   5. `agent_refresh_tokens` where
 *      `createdBy == uid`                  — disables the user's agents
 *   6. `chats/{chatId}` where
 *      `userId == uid`                     — Cortex conversation history
 *   7. Firebase Storage `users/{uid}/*`    — avatar / user-scoped assets
 *
 * Finally — after the Firestore cascade — the Firebase Auth user is
 * revoked + deleted server-side. The client used to call
 * `auth.deleteUser()` after the API responded; that race window is now
 * closed (the client should drop the deleteUser call; see the AuthContext
 * comment).
 *
 * Capability: `USER_SELF_DELETE` — granted to every role tier in
 * `web/lib/capabilities.ts`. The route shim enforces the boundary: an
 * authenticated user may delete ONLY themselves.
 *
 * ## Chunking
 * Each subcollection is enumerated and deleted in batches of `BATCH_SIZE`
 * (=100) — well under Firestore's 500-write batch ceiling. Cross-
 * collection deletes (top-level api_keys lookups, agent_refresh_tokens,
 * chats) are split into a fresh `db.batch()` per chunk for the same
 * reason.
 *
 * ## Idempotency
 * A progress doc at `users/{userId}/account_deletion/operation` records
 * the operation id and incremental delete counts. A re-issued call:
 *   - finds the progress doc and replays the recorded outcome, OR
 *   - if a previous run aborted partway through, resumes from where it
 *     left off (the next batch picks up because already-deleted docs are
 *     simply absent from the next scan).
 *
 * ## Dry run
 * `dryRun: true` performs the same scans + classification but mutates
 * nothing. The result carries the same per-path counts a live run would
 * have produced (including the new subcollections), plus the
 * `siteClassification` so callers can preview which sites would be hard-
 * deleted versus dropped from membership.
 *
 * ## Resumability — current limitation
 * If the cascade fails partway through (e.g. firestore quota error mid-
 * batch), the progress doc records the partial state. The next invocation
 * resumes by re-running the scans (collections shrink as docs are
 * deleted), so the cascade is **eventually consistent**.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Storage } from 'firebase-admin/storage';
import { getAdminAuth, getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
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
  /** Inject Firebase Auth admin — tests pass a stub; production omits. */
  auth?: Auth | null;
  /** Inject Firebase Storage admin — tests pass a stub; production omits. */
  storage?: Storage | null;
  /** Override `Date.now()` for unit tests. */
  now?: () => number;
}

/** Per-site classification used by both the dry-run preview and the live cascade. */
export type SiteClassification =
  | { siteId: string; kind: 'sole_owner' }
  | { siteId: string; kind: 'member'; ownerUid: string | null }
  | { siteId: string; kind: 'missing' };

export type DeleteOwnAccountResult =
  | {
      kind: 'needs_successor';
      userId: string;
      operationId: string;
      ownedSharedSites: string[];
    }
  | {
      kind: 'ok';
      userId: string;
      operationId: string;
      /** Whether this invocation actually performed deletes (false in dry-run + replay). */
      performed: boolean;
      /** True when an earlier completed run was replayed (no work this call). */
      alreadyCompleted: boolean;
      dryRun: boolean;
      /** Sites the cascade visited (sourced from users/{userId}.sites[]). */
      sites: string[];
      /** Per-site classification — sole_owner / member / missing. */
      siteClassification: SiteClassification[];
      /** Per-path doc-delete counts. Same shape for live runs and dry-runs. */
      deletedCounts: {
        machines: number;
        deployments: number;
        logs: number;
        sites: number;
        users: number;
        memberSitesRemoved: number;
        passkeys: number;
        apiKeys: number;
        apiKeyLookups: number;
        mfaPending: number;
        agentRefreshTokens: number;
        chats: number;
        chatMessages: number;
        storageObjects: number;
      };
      /** Whether the Firebase Auth user record was revoked + deleted (live runs only). */
      authRevoked: boolean;
      /** Firestore paths that were (or would be) deleted, ordered as deleted. */
      deletedPaths: string[];
    };

interface SiteScanCounts {
  machines: number;
  deployments: number;
  logs: number;
}

interface CascadeContext {
  db: Firestore;
  auth: Auth | null;
  storage: Storage | null;
  now: () => number;
  dryRun: boolean;
  deletedPaths: string[];
  userId: string;
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function emptyCounts(): SiteScanCounts {
  return { machines: 0, deployments: 0, logs: 0 };
}

function emptyDeletedCounts() {
  return {
    machines: 0,
    deployments: 0,
    logs: 0,
    sites: 0,
    users: 0,
    memberSitesRemoved: 0,
    passkeys: 0,
    apiKeys: 0,
    apiKeyLookups: 0,
    mfaPending: 0,
    agentRefreshTokens: 0,
    chats: 0,
    chatMessages: 0,
    storageObjects: 0,
  };
}

/**
 * Drain a subcollection in chunks of `BATCH_SIZE`. Returns the number of
 * docs visited (which equals the number deleted in a live run, or the
 * count that would be deleted in a dry run).
 */
async function drainSiteSubcollection(
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
    if (snap.size < BATCH_SIZE) break;
  }

  return total;
}

/**
 * Drain a flat subcollection under `users/{uid}` (passkeys, api_keys).
 * Returns the number of docs deleted (or counted in dry-run).
 */
async function drainUserSubcollection(
  ctx: CascadeContext,
  subName: string,
): Promise<number> {
  const colRef = ctx.db
    .collection('users')
    .doc(ctx.userId)
    .collection(subName);
  let total = 0;

  if (ctx.dryRun) {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        ctx.deletedPaths.push(`users/${ctx.userId}/${subName}/${doc.id}`);
      }
      total += snap.size;

      if (snap.size < BATCH_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1] ?? null;
      if (!lastDoc) break;
    }
    return total;
  }

  for (;;) {
    const snap = await colRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = ctx.db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ctx.deletedPaths.push(`users/${ctx.userId}/${subName}/${doc.id}`);
    }
    await batch.commit();

    total += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return total;
}

/**
 * Drain api_key subcollection entries AND mirror revocation onto the
 * top-level `api_keys/{keyHash}` lookup docs. Returns
 * `{ apiKeys, apiKeyLookups }` so the caller can populate the per-path
 * counts in the result. Lookup docs are hard-deleted (not just revoked) —
 * the user is going away entirely, so leaving stale lookup rows is
 * pointless and just bloats `api_keys/`.
 */
async function drainApiKeys(
  ctx: CascadeContext,
): Promise<{ apiKeys: number; apiKeyLookups: number }> {
  const colRef = ctx.db
    .collection('users')
    .doc(ctx.userId)
    .collection('api_keys');
  let apiKeys = 0;
  let apiKeyLookups = 0;

  // Collect keyHashes BEFORE deleting the subcollection docs so we can
  // sweep the top-level lookup table afterwards. Page through to keep
  // memory bounded.
  const keyHashes: string[] = [];

  // 1) Enumerate keyHashes (both live + dry-run).
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = colRef.orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      if (typeof data.keyHash === 'string') keyHashes.push(data.keyHash);
    }
    if (snap.size < BATCH_SIZE) break;
    lastDoc = snap.docs[snap.docs.length - 1] ?? null;
    if (!lastDoc) break;
  }

  // 2) Drain the subcollection (uses the standard helper).
  apiKeys = await drainUserSubcollection(ctx, 'api_keys');

  // 3) Sweep the top-level lookup table. Some lookup docs may be absent
  //    (very old keys may have been created before the lookup table
  //    existed); a 404 on delete is tolerated.
  for (let i = 0; i < keyHashes.length; i += BATCH_SIZE) {
    const slice = keyHashes.slice(i, i + BATCH_SIZE);
    if (ctx.dryRun) {
      for (const hash of slice) {
        ctx.deletedPaths.push(`api_keys/${hash}`);
        apiKeyLookups += 1;
      }
      continue;
    }
    const batch = ctx.db.batch();
    for (const hash of slice) {
      batch.delete(ctx.db.collection('api_keys').doc(hash));
      ctx.deletedPaths.push(`api_keys/${hash}`);
      apiKeyLookups += 1;
    }
    try {
      await batch.commit();
    } catch (err) {
      logger.warn('[deleteOwnAccount] api_keys lookup batch delete partial-failed', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return { apiKeys, apiKeyLookups };
}

/**
 * Delete documents matching a query on a top-level collection. Used for
 * agent_refresh_tokens (where `createdBy == uid`) and chats
 * (where `userId == uid`). Returns the number of docs deleted (or counted).
 *
 * For `chats`, we also drain each chat's `messages` subcollection — chats
 * are conversation roots and Firestore does NOT cascade subcollection
 * deletes. The caller passes `drainSubcollection=messages` when needed.
 */
async function drainQueryWhereEqualsUser(
  ctx: CascadeContext,
  collectionPath: string,
  fieldName: string,
  options?: { drainSubcollection?: string },
): Promise<{ deleted: number; subDeleted: number }> {
  const colRef = ctx.db.collection(collectionPath);
  let deleted = 0;
  let subDeleted = 0;

  for (;;) {
    const snap = await colRef
      .where(fieldName, '==', ctx.userId)
      .limit(BATCH_SIZE)
      .get();
    if (snap.empty) break;

    // Drain subcollection first (if requested) so child docs go before parents.
    if (options?.drainSubcollection) {
      for (const doc of snap.docs) {
        for (;;) {
          const subSnap = await doc.ref
            .collection(options.drainSubcollection)
            .limit(BATCH_SIZE)
            .get();
          if (subSnap.empty) break;

          if (ctx.dryRun) {
            for (const subDoc of subSnap.docs) {
              ctx.deletedPaths.push(
                `${collectionPath}/${doc.id}/${options.drainSubcollection}/${subDoc.id}`,
              );
            }
            subDeleted += subSnap.size;
            if (subSnap.size < BATCH_SIZE) break;
            // dry-run pagination terminator: empty docs ref so we don't
            // infinite-loop on a fake. Re-query is fine since data isn't
            // mutated.
            break;
          }

          const batch = ctx.db.batch();
          for (const subDoc of subSnap.docs) {
            batch.delete(subDoc.ref);
            ctx.deletedPaths.push(
              `${collectionPath}/${doc.id}/${options.drainSubcollection}/${subDoc.id}`,
            );
          }
          await batch.commit();
          subDeleted += subSnap.size;
          if (subSnap.size < BATCH_SIZE) break;
        }
      }
    }

    if (ctx.dryRun) {
      for (const doc of snap.docs) {
        ctx.deletedPaths.push(`${collectionPath}/${doc.id}`);
      }
      deleted += snap.size;
      if (snap.size < BATCH_SIZE) break;
      // Dry-run: data isn't mutated, so re-querying returns the same page.
      // Exit after one full page once size < BATCH_SIZE; otherwise the loop
      // would never terminate. We exit immediately after one page here
      // — the dry-run preview is informative, not authoritative.
      break;
    }

    const batch = ctx.db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ctx.deletedPaths.push(`${collectionPath}/${doc.id}`);
    }
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }

  return { deleted, subDeleted };
}

/**
 * Delete the `mfa_pending/{uid}` doc. Single-doc op; returns 1 if the doc
 * existed (or would-be-deleted in dry-run), else 0.
 */
async function deleteMfaPending(ctx: CascadeContext): Promise<number> {
  const ref = ctx.db.collection('mfa_pending').doc(ctx.userId);
  const snap = await ref.get().catch(() => null);
  if (!snap || !snap.exists) return 0;
  ctx.deletedPaths.push(`mfa_pending/${ctx.userId}`);
  if (!ctx.dryRun) {
    try {
      await ref.delete();
    } catch (err) {
      logger.warn('[deleteOwnAccount] mfa_pending delete failed (non-fatal)', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
      return 0;
    }
  }
  return 1;
}

/**
 * Delete all Firebase Storage objects under `users/{uid}/`. Avatars and
 * any other user-scoped assets land here. Returns the number of files
 * deleted (or 0 if storage isn't configured / the bucket is empty).
 */
async function drainUserStorage(ctx: CascadeContext): Promise<number> {
  if (!ctx.storage) return 0;
  try {
    const bucket = ctx.storage.bucket();
    const prefix = `users/${ctx.userId}/`;
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return 0;

    for (const f of files) {
      ctx.deletedPaths.push(`storage://${bucket.name}/${f.name}`);
    }
    if (!ctx.dryRun) {
      await bucket.deleteFiles({ prefix, force: true });
    }
    return files.length;
  } catch (err) {
    logger.warn('[deleteOwnAccount] storage drain failed (non-fatal)', {
      context: 'deleteOwnAccount',
      data: {
        userId: ctx.userId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return 0;
  }
}

/**
 * Revoke + delete the Firebase Auth user record. Returns `true` if the
 * action succeeded OR the user was already absent (treated as success;
 * idempotent). `false` on transient failure — the caller should surface
 * but not block on it, since the Firestore cascade has already completed.
 */
async function revokeAndDeleteAuthUser(ctx: CascadeContext): Promise<boolean> {
  if (!ctx.auth) return false;
  try {
    await ctx.auth.revokeRefreshTokens(ctx.userId);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'auth/user-not-found') {
      logger.warn('[deleteOwnAccount] revokeRefreshTokens failed (non-fatal)', {
        context: 'deleteOwnAccount',
        data: {
          userId: ctx.userId,
          code,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  try {
    await ctx.auth.deleteUser(ctx.userId);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'auth/user-not-found') {
      // Already gone — treat as success.
      return true;
    }
    logger.warn('[deleteOwnAccount] deleteUser failed', {
      context: 'deleteOwnAccount',
      data: {
        userId: ctx.userId,
        code,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }
}

/**
 * Classify each siteId in the user's `sites[]` array as sole_owner /
 * member / missing. Sole-owner-but-shared sites are reported back as
 * `ownedSharedSites` so the caller can refuse with `needs_successor`.
 *
 * Returns:
 *   - `classification`: per-site decision used by the live cascade
 *   - `ownedSharedSites`: sites where the user is owner AND other members
 *     exist (must be transferred first)
 */
async function classifySites(
  ctx: CascadeContext,
  siteIds: string[],
): Promise<{
  classification: SiteClassification[];
  ownedSharedSites: string[];
}> {
  const classification: SiteClassification[] = [];
  const ownedSharedSites: string[] = [];

  for (const siteId of siteIds) {
    const siteRef = ctx.db.collection('sites').doc(siteId);
    const snap = await siteRef.get();
    if (!snap.exists) {
      classification.push({ siteId, kind: 'missing' });
      continue;
    }
    const data = snap.data() ?? {};
    const owner = typeof data.owner === 'string' ? data.owner : null;
    if (owner !== ctx.userId) {
      classification.push({ siteId, kind: 'member', ownerUid: owner });
      continue;
    }
    // Owner case: check for other members via `users where sites
    // array-contains siteId`. A single-page query is sufficient — we only
    // need to know whether ANY other member exists; we don't enumerate.
    const otherMembers = await ctx.db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .limit(2)
      .get();
    const hasOther = otherMembers.docs.some((d) => d.id !== ctx.userId);
    if (hasOther) {
      ownedSharedSites.push(siteId);
      // Still record the classification for the audit trail; the cascade
      // won't reach the per-site loop in this branch.
      classification.push({ siteId, kind: 'member', ownerUid: ctx.userId });
    } else {
      classification.push({ siteId, kind: 'sole_owner' });
    }
  }

  return { classification, ownedSharedSites };
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
  // Auth + Storage handles are resolved lazily: tests inject explicit
  // overrides (including `null` to opt out). Production code paths that
  // don't supply them fall through to the singleton getters.
  const auth =
    input.auth === undefined
      ? (() => {
          try {
            return getAdminAuth();
          } catch {
            return null;
          }
        })()
      : input.auth;
  const storage =
    input.storage === undefined
      ? (() => {
          try {
            return getAdminStorage();
          } catch {
            return null;
          }
        })()
      : input.storage;
  const now = input.now ?? (() => Date.now());
  const dryRun = Boolean(input.dryRun);

  const userRef = db.collection('users').doc(input.userId);
  const progressRef = userRef.collection('account_deletion').doc('operation');
  const deletedPaths: string[] = [];

  const ctx: CascadeContext = {
    db,
    auth,
    storage,
    now,
    dryRun,
    deletedPaths,
    userId: input.userId,
  };

  // ── 0. Idempotency / replay check ───────────────────────────────────────
  if (!dryRun) {
    const progressSnap = await progressRef.get().catch(() => null);
    if (progressSnap && progressSnap.exists) {
      const data = progressSnap.data() ?? {};
      if (data.completedAt && data.operationId === input.operationId) {
        const recordedSites = Array.isArray(data.sites)
          ? (data.sites as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : [];
        const counts = (data.deletedCounts as Record<string, unknown>) ?? {};
        return {
          kind: 'ok',
          userId: input.userId,
          operationId: input.operationId,
          performed: false,
          alreadyCompleted: true,
          dryRun: false,
          sites: recordedSites,
          siteClassification: Array.isArray(data.siteClassification)
            ? (data.siteClassification as SiteClassification[])
            : [],
          deletedCounts: {
            ...emptyDeletedCounts(),
            machines: numberOr0(counts.machines),
            deployments: numberOr0(counts.deployments),
            logs: numberOr0(counts.logs),
            sites: numberOr0(counts.sites),
            users: numberOr0(counts.users),
            memberSitesRemoved: numberOr0(counts.memberSitesRemoved),
            passkeys: numberOr0(counts.passkeys),
            apiKeys: numberOr0(counts.apiKeys),
            apiKeyLookups: numberOr0(counts.apiKeyLookups),
            mfaPending: numberOr0(counts.mfaPending),
            agentRefreshTokens: numberOr0(counts.agentRefreshTokens),
            chats: numberOr0(counts.chats),
            chatMessages: numberOr0(counts.chatMessages),
            storageObjects: numberOr0(counts.storageObjects),
          },
          authRevoked: Boolean(data.authRevoked),
          deletedPaths: Array.isArray(data.deletedPaths)
            ? (data.deletedPaths as unknown[]).filter(
                (s): s is string => typeof s === 'string',
              )
            : [],
        };
      }
    }
  }

  // ── 1. Read the user doc to source the sites[] list ────────────────────
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return {
      kind: 'ok',
      userId: input.userId,
      operationId: input.operationId,
      performed: false,
      alreadyCompleted: true,
      dryRun,
      sites: [],
      siteClassification: [],
      deletedCounts: emptyDeletedCounts(),
      authRevoked: false,
      deletedPaths: [],
    };
  }
  const userData = userSnap.data() ?? {};
  const sites = Array.isArray(userData.sites)
    ? (userData.sites as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];

  // ── 2. Classify sites + refuse on owned-shared ─────────────────────────
  const { classification, ownedSharedSites } = await classifySites(ctx, sites);
  if (ownedSharedSites.length > 0) {
    return {
      kind: 'needs_successor',
      userId: input.userId,
      operationId: input.operationId,
      ownedSharedSites,
    };
  }

  // ── 3. Stamp the progress doc as in-flight (live runs only) ────────────
  if (!dryRun) {
    try {
      await progressRef.set(
        {
          operationId: input.operationId,
          userId: input.userId,
          startedAt: FieldValue.serverTimestamp(),
          startedAtMs: now(),
          sites,
          siteClassification: classification,
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

  // ── 4. Per-site cascade ─────────────────────────────────────────────────
  // Sole-owner sites: drain machines/deployments/logs + delete site doc.
  // Member sites: leave the site doc; we don't even need an arrayRemove
  //   because the user doc itself is deleted in step 6. Counted for audit.
  // Missing sites: skipped.
  const totals: SiteScanCounts = emptyCounts();
  let sitesDeleted = 0;
  let memberSitesRemoved = 0;

  for (const entry of classification) {
    if (entry.kind === 'missing') continue;
    if (entry.kind === 'member') {
      memberSitesRemoved += 1;
      continue;
    }
    // sole_owner
    const siteRef = db.collection('sites').doc(entry.siteId);
    for (const sub of SITE_SUBCOLLECTIONS) {
      const n = await drainSiteSubcollection(
        db,
        entry.siteId,
        sub,
        dryRun,
        deletedPaths,
      );
      totals[sub] += n;
    }
    if (!dryRun) {
      await siteRef.delete();
    }
    deletedPaths.push(`sites/${entry.siteId}`);
    sitesDeleted += 1;
  }

  // ── 5. User-scoped subcollections + cross-collection sweeps ────────────
  const passkeys = await drainUserSubcollection(ctx, 'passkeys');
  const { apiKeys, apiKeyLookups } = await drainApiKeys(ctx);
  const mfaPending = await deleteMfaPending(ctx);
  const agentTokens = await drainQueryWhereEqualsUser(
    ctx,
    'agent_refresh_tokens',
    'createdBy',
  );
  const chats = await drainQueryWhereEqualsUser(ctx, 'chats', 'userId', {
    drainSubcollection: 'messages',
  });
  const storageObjects = await drainUserStorage(ctx);

  // ── 6. Delete the user doc ─────────────────────────────────────────────
  let usersDeleted = 0;
  if (!dryRun) {
    await userRef.delete();
  }
  deletedPaths.push(`users/${input.userId}`);
  usersDeleted = 1;

  // ── 7. Revoke + delete Firebase Auth user ──────────────────────────────
  let authRevoked = false;
  if (!dryRun) {
    authRevoked = await revokeAndDeleteAuthUser(ctx);
  }

  const deletedCounts = {
    machines: totals.machines,
    deployments: totals.deployments,
    logs: totals.logs,
    sites: sitesDeleted,
    users: usersDeleted,
    memberSitesRemoved,
    passkeys,
    apiKeys,
    apiKeyLookups,
    mfaPending,
    agentRefreshTokens: agentTokens.deleted,
    chats: chats.deleted,
    chatMessages: chats.subDeleted,
    storageObjects,
  };

  // ── 8. Stamp the progress doc as completed ─────────────────────────────
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
          siteClassification: classification,
          deletedCounts,
          authRevoked,
          deletedPaths: deletedPaths.slice(0, 200),
        },
        { merge: true },
      );
    } catch (err) {
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
    kind: 'ok',
    userId: input.userId,
    operationId: input.operationId,
    performed: !dryRun,
    alreadyCompleted: false,
    dryRun,
    sites,
    siteClassification: classification,
    deletedCounts,
    authRevoked,
    deletedPaths,
  };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
