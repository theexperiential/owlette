/**
 * POST /api/roosts/{roostId}/rollback
 *      in:  { siteId: string, targetVersion?: string | number }
 *      out: { ok, roostId, siteId, currentVersionId, currentVersionNumber, previousVersionId }
 *
 * Flips `currentVersionId` to an already-published version. Mints NO new
 * version — versions are immutable, a rollback is a pointer change.
 *
 * `targetVersion` takes any form `web/lib/resolveVersion.ts` accepts (alias
 * 'current'|'previous'|'first', stable id 'vrs_<hex>', number 3/'3'/'#3'/'v3').
 * Defaults to 'previous' — one-click "undo last publish".
 *
 * Auth: scope `rollback` (`web/lib/apiKeyTypes.ts`), distinct from write so an
 * operator key can roll back without being able to push.
 *
 * Dispatch: the pointer flip must NOT let the fan-out trigger replay its
 * deterministic `roost_sync_{roostId}_{versionId}` command id, so the route
 * keeps/creates `rollouts/{targetVersionId}` (making `onRoostWritten` bail) and
 * enqueues nonce'd `sync_pull` commands itself.
 *
 * Webhooks: `version.rolled_back` is QUEUED per subscription after the flip and
 * dispatch land; `functions/src/webhookDispatch.ts` owns delivery and backoff.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  resolveVersion,
  ResolveVersionError,
} from '@/lib/resolveVersion';
import { emitRoostWebhook } from '@/lib/roostWebhooks.server';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

const DEFAULT_TARGET = 'previous';
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';
const ROLLBACK_DISPATCH_BATCH_SIZE = 400;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

async function commitBatchIfNeeded(
  state: { batch: WriteBatch; ops: number },
  db: Firestore,
  nextOps: number,
): Promise<void> {
  if (state.ops > 0 && state.ops + nextOps > ROLLBACK_DISPATCH_BATCH_SIZE) {
    await state.batch.commit();
    state.batch = db.batch();
    state.ops = 0;
  }
}

async function dispatchRollbackSyncPulls(args: {
  db: Firestore;
  siteId: string;
  roostId: string;
  versionId: string;
  versionUrl: string;
  extractRoot: string;
  targets: string[];
  nonce: string;
  requestedBy: string;
}): Promise<void> {
  const {
    db,
    siteId,
    roostId,
    versionId,
    versionUrl,
    extractRoot,
    targets,
    nonce,
    requestedBy,
  } = args;
  const deterministicCmdId = `roost_sync_${roostId}_${versionId}`;
  const rollbackCmdId = `roost_rollback_${roostId}_${versionId}_${nonce}`;
  const state = { batch: db.batch(), ops: 0 };

  for (const machineId of targets) {
    await commitBatchIfNeeded(state, db, 3);

    const machineRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId);
    const pendingRef = machineRef.collection('commands').doc('pending');
    const completedRef = machineRef.collection('commands').doc('completed');
    const targetStateRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('target_state')
      .doc(machineId);

    state.batch.set(
      pendingRef,
      {
        [rollbackCmdId]: {
          type: 'sync_pull',
          site_id: siteId,
          roost_id: roostId,
          version_id: versionId,
          version_url: versionUrl,
          extract_root: extractRoot,
          queued_at: FieldValue.serverTimestamp(),
          rollback: true,
          rollback_requested_by: requestedBy,
        },
        [deterministicCmdId]: FieldValue.delete(),
      },
      { merge: true },
    );
    state.ops += 1;

    state.batch.set(
      completedRef,
      { [deterministicCmdId]: FieldValue.delete() },
      { merge: true },
    );
    state.ops += 1;

    state.batch.delete(targetStateRef);
    state.ops += 1;
  }

  if (state.ops > 0) {
    await state.batch.commit();
  }
}

/**
 * Resolver error -> RFC 7807. Mirrors the helper in the versions/[versionRef]
 * route so error envelopes stay identical across every versionRef endpoint.
 */
function problemFromResolveError(
  err: ResolveVersionError,
  instance: string,
): NextResponse {
  return problem({
    type: err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
    title: err.status === 404 ? 'version not found' : 'targetVersion malformed',
    status: err.status,
    detail: err.message,
    instance,
    code: err.code,
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as {
      siteId?: unknown;
      targetVersion?: unknown;
    };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    // Scope `rollback`: the operator preset grants it alongside
    // read/write/deploy; a read-only key gets 403 scope_insufficient.
    const auth = await requireRoostAuthAndScope(
      request,
      site.siteId,
      roostId,
      'rollback',
    );
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    // Idempotency replay (same pattern as the versions PATCH handler): a
    // double-click on a flaky network must not double-flip or fire two waves.
    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    // Optional; string OR number only. Objects/arrays/booleans 400 here rather
    // than being coerced or buried in the resolver.
    const rawTarget = body.targetVersion;
    if (
      rawTarget !== undefined &&
      rawTarget !== null &&
      typeof rawTarget !== 'string' &&
      typeof rawTarget !== 'number'
    ) {
      return problemValidation(
        'targetVersion must be a string or number when provided',
        { 'body.targetVersion': ['must be a string or number'] },
      );
    }
    const refInput =
      rawTarget === undefined || rawTarget === null
        ? DEFAULT_TARGET
        : String(rawTarget);

    // Same ref grammar as GET/PATCH /versions/{versionRef}. Side-effect free;
    // throws ResolveVersionError.
    let resolved;
    try {
      resolved = await resolveVersion({
        roostId,
        siteId: site.siteId,
        ref: refInput,
      });
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problemFromResolveError(
          err,
          `/api/roosts/${roostId}/rollback`,
        );
      }
      throw err;
    }
    const resolvedData = resolved.doc.data() ?? {};
    const versionUrl =
      typeof resolvedData.versionUrl === 'string' && resolvedData.versionUrl
        ? resolvedData.versionUrl
        : null;

    // Compare-and-swap in a transaction: the transactional read of the roost
    // head catches a concurrent push landing between resolveVersion() and the
    // update — firestore retries the callback if the doc moved.
    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);
    const rolloutRef = roostRef.collection('rollouts').doc(resolved.versionId);
    const nonce = Date.now().toString(36);

    const txResult = await db.runTransaction(async (tx) => {
      const roostSnap = await tx.get(roostRef);
      if (!roostSnap.exists) {
        return { kind: 'not_found' as const };
      }
      const existing = roostSnap.data() ?? {};
      if (existing.deletedAt) {
        return { kind: 'not_found' as const };
      }

      const currentId = (existing.currentVersionId as string | undefined) ?? null;
      if (currentId === resolved.versionId) {
        return { kind: 'no_op' as const, currentId };
      }
      if (!versionUrl) {
        return { kind: 'version_url_missing' as const };
      }
      const targets = Array.isArray(existing.targets)
        ? [
            ...new Set(
              (existing.targets as unknown[]).filter(
                (target): target is string =>
                  typeof target === 'string' && target.length > 0,
              ),
            ),
          ]
        : [];
      const extractRoot =
        typeof existing.extractPath === 'string' && existing.extractPath.trim()
          ? existing.extractPath.trim()
          : DEFAULT_EXTRACT_ROOT;

      // Denormalised onto the roost doc so the /roost list and the dispatcher
      // cloud function read it without a sub-collection round-trip. Same field
      // set POST /versions writes on a fresh push.
      tx.update(roostRef, {
        currentVersionId: resolved.versionId,
        currentVersionNumber: resolved.versionNumber,
        currentVersionDescription:
          typeof resolvedData.description === 'string'
            ? resolvedData.description
            : null,
        previousVersionId: currentId,
        versionUrl,
        totalFiles:
          typeof resolvedData.totalFiles === 'number' ? resolvedData.totalFiles : 0,
        totalSize:
          typeof resolvedData.totalSize === 'number' ? resolvedData.totalSize : 0,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Terminal guard: onRoostWritten bails when rollouts/{versionId} exists,
      // and terminal also stops an older in-flight rollout from later promoting
      // a deterministic fleet command for this version.
      tx.set(
        rolloutRef,
        {
          stage: 'complete',
          versionId: resolved.versionId,
          versionUrl,
          extractRoot,
          canary: targets,
          fleet: [],
          startedAt: FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp(),
          pendingCommandsDispatched: true,
          pendingCommandsDispatchedAt: FieldValue.serverTimestamp(),
          rollback: true,
          rollbackFromVersionId: currentId,
          rollbackBy: auth.userId,
          rollbackNonce: nonce,
        },
        { merge: true },
      );

      return {
        kind: 'flipped' as const,
        previousVersionId: currentId,
        versionUrl,
        targets,
        extractRoot,
      };
    });

    if (txResult.kind === 'not_found') {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }
    if (txResult.kind === 'no_op') {
      // Defensive: the UI hides rollback on the current row, but a direct API
      // caller deserves a 400 over a silent no-op.
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'rollback no-op',
        status: 400,
        detail: 'targetVersion is already the current version',
        instance: `/api/roosts/${roostId}/rollback`,
        code: 'rollback_no_op',
      });
    }
    if (txResult.kind === 'version_url_missing') {
      return problem({
        type: ProblemType.Conflict,
        title: 'version has no url',
        status: 409,
        detail: 'the target version exists but its R2 url is missing; cannot fan out rollback',
        instance: `/api/roosts/${roostId}/rollback`,
        code: 'version_url_missing',
      });
    }

    await dispatchRollbackSyncPulls({
      db,
      siteId: site.siteId,
      roostId,
      versionId: resolved.versionId,
      versionUrl: txResult.versionUrl,
      extractRoot: txResult.extractRoot,
      targets: txResult.targets,
      nonce,
      requestedBy: auth.userId,
    });

    // Awaited so a 200 means the event is durably queued; the scheduled pump in
    // functions/src/webhookDispatch.ts does the POSTing. Never throws — a
    // webhook outage must not fail a completed rollback.
    await emitRoostWebhook({
      db,
      siteId: site.siteId,
      event: 'version.rolled_back',
      data: {
        roostId,
        siteId: site.siteId,
        fromVersion: txResult.previousVersionId,
        toVersion: resolved.versionId,
        triggeredBy: auth.userId,
      },
    });

    const response = applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        roostId,
        siteId: site.siteId,
        currentVersionId: resolved.versionId,
        currentVersionNumber: resolved.versionNumber,
        previousVersionId: txResult.previousVersionId,
      }),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: resolved.versionId,
      attributes: {
        verb: 'rollback',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        roostId,
        targetVersion: refInput,
        fromVersionId: txResult.previousVersionId,
        toVersionId: resolved.versionId,
        toVersionNumber: resolved.versionNumber,
      },
    });
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/rollback');
  }
}
