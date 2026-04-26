// @auth-bypass: self-delete is "actor IS target" — `authorizedSiteHandler`
// requires site access (not applicable: user may have no sites) and
// `authorizedPlatformHandler` requires superadmin (not applicable: any
// authenticated user may delete themselves). Auth + capability + audit are
// enforced inline below; see the file header for the full design.
/**
 * DELETE /api/users/me — server-side account self-deletion cascade
 *                        (security-boundary-migration wave 3.10).
 *
 * Replaces the legacy client-side `writeBatch` cascade in
 * `web/contexts/AuthContext.tsx`'s `deleteAccount`. The server cascade is
 * authoritative: the client will no longer enumerate sites / machines /
 * deployments / logs from the browser. Re-authentication and Firebase Auth
 * account deletion remain client-side because credentials don't cross the
 * security boundary.
 *
 * ## Auth model
 * The actor IS the target — a user deleting THEMSELVES. Site access doesn't
 * apply (the user may have zero sites, or sites they're a member of but
 * don't own). The standard `authorizedSiteHandler` is therefore not used.
 * Instead this route requires `requireSession` (cookie-only — no API keys,
 * because a key holder shouldn't be able to delete the user's account
 * remotely; that's reserved for the explicit `DELETE /api/users/{uid}`
 * superadmin route).
 *
 * Capability: `USER_SELF_DELETE` — granted to every role tier in the role
 * matrix. The capability gate is enforced inline (rather than via the
 * shared handler wrapper) because the wrapper variants don't support the
 * "actor IS target" shape.
 *
 * ## Audit
 * One audit entry per call, written to the platform audit log
 * (`global/audit_log/{entryId}`) with:
 *   - `actor.type=user`, `actor.userId={userId}`, `actor.role={role}`
 *   - `capability=USER_SELF_DELETE`
 *   - `target.kind=user`, `target.id={userId}`
 *   - `metadata` includes the per-path delete counts so post-mortem
 *     analysis can verify what was removed.
 *
 * ## Query params
 * - `dryRun=1` — runs the scans but performs no deletes; the response
 *   carries the count of docs that WOULD be deleted.
 *
 * ## Idempotency
 * The action core records progress under
 * `users/{userId}/account_deletion/operation`. A re-issued DELETE with the
 * same `Idempotency-Key` (or, when no header is set, with the same
 * synthesised operation id) is a no-op that returns the recorded outcome.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  ApiAuthError,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import {
  Capability,
  hasCapability,
  type Actor,
  type Role,
  type UserActor,
} from '@/lib/capabilities';
import { securityConfig } from '@/lib/securityConfig.server';
import { generateCorrelationId } from '@/lib/auditLog.server';
import { deleteOwnAccount } from '@/lib/actions/deleteOwnAccount.server';
import logger from '@/lib/logger';

interface ActorRecord {
  actor: UserActor;
  userId: string;
  role: Role;
}

/**
 * Resolve the calling user's session into a UserActor. Refuses API-key
 * auth: self-delete is a "you, in person" action and must come from a
 * cookie session or a freshly-issued ID token.
 */
async function resolveSelfActor(request: NextRequest): Promise<ActorRecord> {
  // Reject API keys explicitly — `requireSessionOrIdToken` already does
  // this implicitly (it ignores `owk_*` bearer tokens), but a clearer
  // 401 here helps callers diagnose misconfigured CLIs.
  const apiHeader =
    request.headers.get('x-api-key') ||
    request.nextUrl.searchParams.get('api_key');
  if (apiHeader && apiHeader.startsWith('owk_')) {
    throw new ApiAuthError(401, 'self-delete requires a session or id-token, not an api key');
  }

  const userId = await requireSessionOrIdToken(request);

  // Load role from the user doc. If the doc has been hard-deleted by a
  // superadmin in the meantime, treat the role as 'member' (least
  // privilege) — the cascade will short-circuit on the missing doc.
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const data = userDoc.exists ? userDoc.data() : null;
  const rawRole = data?.role;
  const role: Role =
    rawRole === 'superadmin' || rawRole === 'admin' ? rawRole : 'member';
  const sites = Array.isArray(data?.sites)
    ? (data?.sites as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  const actor: UserActor = { type: 'user', userId, role, sites };
  return { actor, userId, role };
}

interface PlatformAuditEntry {
  correlationId: string;
  actor: { type: 'user'; userId: string; role: Role };
  capability: typeof Capability.USER_SELF_DELETE;
  target: { kind: 'user'; id: string };
  outcome: 'allow' | 'deny' | 'error';
  metadata?: Record<string, unknown>;
  denyReason?: string;
  errorCode?: string;
  enforcementBypassed?: boolean;
}

/**
 * Inline platform audit writer. Mirrors the shape used by
 * `authorizedPlatformHandler` (which keeps its writer private). When the
 * shared writer is exported in a future cleanup (wave 1.3 follow-up), this
 * helper collapses to a single import.
 */
async function writeSelfDeleteAudit(
  entry: PlatformAuditEntry,
  blocking: boolean,
): Promise<void> {
  const db = getAdminDb();
  const docRef = db
    .collection('global')
    .doc('audit_log')
    .collection('entries')
    .doc();

  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: entry.target,
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }

  if (blocking) {
    await docRef.set(payload);
  } else {
    void docRef.set(payload).catch((err) => {
      logger.error('self-delete audit write failed (fire-and-forget)', {
        context: 'users/me',
        data: {
          correlationId: entry.correlationId,
          outcome: entry.outcome,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    });
  }
}

/**
 * Build a stable operation id for the action core's progress doc.
 *
 *   - When the caller sends `Idempotency-Key`, derive the op id from it
 *     (sha256 of header value) so a retry maps to the same progress doc.
 *   - Otherwise, fall back to a per-user fixed id so concurrent retries
 *     during a network blip still collapse onto the same record. (We
 *     don't generate a fresh random id per request — that would defeat
 *     the resumability guarantee the action core depends on.)
 */
function deriveOperationId(request: NextRequest, userId: string): string {
  const header = request.headers.get('idempotency-key');
  if (header && header.length > 0) {
    return crypto.createHash('sha256').update(`${userId}:${header}`).digest('hex');
  }
  return crypto.createHash('sha256').update(`account-self-delete:${userId}`).digest('hex');
}

export async function DELETE(request: NextRequest) {
  const correlationId = generateCorrelationId();

  // ── 1. Resolve auth ────────────────────────────────────────────────────
  let actorRecord: ActorRecord;
  try {
    actorRecord = await resolveSelfActor(request);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 401) return problemUnauthorized(err.message);
      if (err.status === 403) return problemForbidden(err.message);
      return problem({
        type: ProblemType.Internal,
        title: 'authorization error',
        status: err.status,
        detail: err.message,
      });
    }
    return problemFromError(err, 'users/me:DELETE');
  }
  const { actor, userId, role } = actorRecord;

  // ── 2. Capability gate (kill-switch aware) ─────────────────────────────
  let config: { capability_enforcement: boolean };
  try {
    config = await securityConfig.read();
  } catch (err) {
    logger.error('[users/me:DELETE] securityConfig read failed', {
      context: 'users/me',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'service unavailable',
      status: 503,
      detail: 'security config unavailable',
    });
  }

  const enforcementBypassed = !config.capability_enforcement;
  if (config.capability_enforcement) {
    const ok = hasCapability(actor as Actor, Capability.USER_SELF_DELETE);
    if (!ok) {
      void writeSelfDeleteAudit(
        {
          correlationId,
          actor: { type: 'user', userId, role },
          capability: Capability.USER_SELF_DELETE,
          target: { kind: 'user', id: userId },
          outcome: 'deny',
          denyReason: 'capability_missing',
          metadata: { route: request.nextUrl.pathname, method: 'DELETE' },
        },
        false,
      );
      return problemForbidden('capability not granted');
    }
  }

  // ── 3. Parse query params ──────────────────────────────────────────────
  const dryRunParam = request.nextUrl.searchParams.get('dryRun');
  const dryRun =
    dryRunParam === '1' || dryRunParam === 'true' || dryRunParam === 'yes';

  const operationId = deriveOperationId(request, userId);

  // ── 4. Run the cascade ─────────────────────────────────────────────────
  let result;
  try {
    result = await deleteOwnAccount({
      userId,
      dryRun,
      operationId,
    });
  } catch (err) {
    void writeSelfDeleteAudit(
      {
        correlationId,
        actor: { type: 'user', userId, role },
        capability: Capability.USER_SELF_DELETE,
        target: { kind: 'user', id: userId },
        outcome: 'error',
        errorCode: err instanceof Error ? err.name : 'cascade_error',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'DELETE',
          dryRun,
          operationId,
        },
        enforcementBypassed,
      },
      false,
    );
    return problemFromError(err, 'users/me:DELETE');
  }

  // ── 5. Allow audit (blocking) ──────────────────────────────────────────
  // Audit row carries per-path delete counts so post-mortem analysis can
  // verify what was actually removed. Recorded BEFORE the response so a
  // failed write surfaces as 503 — privileged actions never run untracked.
  try {
    await writeSelfDeleteAudit(
      {
        correlationId,
        actor: { type: 'user', userId, role },
        capability: Capability.USER_SELF_DELETE,
        target: { kind: 'user', id: userId },
        outcome: 'allow',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'DELETE',
          dryRun: result.dryRun,
          operationId: result.operationId,
          alreadyCompleted: result.alreadyCompleted,
          deletedCounts: result.deletedCounts,
          siteCount: result.sites.length,
        },
        enforcementBypassed,
      },
      true,
    );
  } catch (err) {
    logger.error('[users/me:DELETE] allow-audit write failed; refusing response', {
      context: 'users/me',
      data: {
        correlationId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
    return problem({
      type: ProblemType.ServiceUnavailable,
      title: 'service unavailable',
      status: 503,
      detail: 'audit log unavailable; refusing privileged action',
    });
  }

  // ── 6. Response ────────────────────────────────────────────────────────
  return NextResponse.json({
    userId: result.userId,
    operationId: result.operationId,
    correlationId,
    performed: result.performed,
    alreadyCompleted: result.alreadyCompleted,
    dryRun: result.dryRun,
    sites: result.sites,
    deletedCounts: result.deletedCounts,
    // For dry-runs, return the full would-delete path list so the caller
    // can preview. For live runs, return only the head (the action core
    // truncates the persisted slice the same way).
    deletedPaths: result.dryRun
      ? result.deletedPaths
      : result.deletedPaths.slice(0, 200),
  });
}
