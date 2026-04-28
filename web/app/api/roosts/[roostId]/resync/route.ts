/**
 * POST /api/roosts/{roostId}/resync
 *      input:  { siteId: string }
 *      output: { resynced: number, targets: string[] }
 *
 * Force every current target to re-pull the current version. Intended
 * for operator-initiated retry after a sync failure, or to re-verify
 * drift (kiosk tech changed files by hand — operator wants them reset).
 *
 * Design notes (why not go through `onRoostWritten`):
 * - The fan-out trigger is idempotent per `rollouts/{versionId}` and
 *   only fires on `currentVersionId` changes, so "re-fire with the same
 *   version" can't reuse the trigger without extra signalling.
 * - A resync is an explicit operator action ("try again, now"), so
 *   skipping canary→fleet staging is desirable — the canary wave already
 *   ran (or failed); this is the retry-all lane.
 *
 * Effects (all applied atomically in one BulkWriter commit):
 * - Delete `target_state/{machineId}` for every current target so the UI
 *   snaps back to "queued" instead of keeping the stale "failed" pill.
 * - Delete `rollouts/{currentVersionId}` so any stored canary state
 *   from the original attempt doesn't shadow the resync.
 * - Queue a fresh `sync_pull` pending command at
 *   `sites/{siteId}/machines/{machineId}/commands/pending` with a
 *   unique cmdId (the agent dedupes by cmdId, so reusing the original
 *   `roost_sync_{roostId}_{versionId}` would be skipped on replay).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  parseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';

// Match the agent's destination_allowlist DEFAULT_ROOTS. Keep in sync
// with the cloud function's DEFAULT_EXTRACT_ROOT — both fall back to
// the same literal so agent-side `~` expansion lands on the same path.
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'deploy');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const snap = await roostRef.get();
    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/resync`,
      });
    }
    const data = snap.data() ?? {};
    const versionId = (data.currentVersionId as string | undefined) ?? null;
    const versionUrl = (data.versionUrl as string | undefined) ?? null;
    const targets = Array.isArray(data.targets) ? (data.targets as string[]) : [];
    const extractRoot =
      typeof data.extractPath === 'string' && data.extractPath.trim()
        ? data.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    if (!versionId || !versionUrl) {
      return problem({
        type: ProblemType.Conflict,
        title: 'nothing to resync',
        status: 409,
        detail:
          'roost has no current version to re-pull. upload a new distribution first.',
        instance: `/api/roosts/${roostId}/resync`,
      });
    }
    if (targets.length === 0) {
      return problem({
        type: ProblemType.Conflict,
        title: 'no targets',
        status: 409,
        detail: 'roost has no targets assigned — nothing to re-sync.',
        instance: `/api/roosts/${roostId}/resync`,
      });
    }

    // Single timestamp-suffix nonce shared across this resync so every
    // target machine sees the same cmdId family. Cheap way to guarantee
    // uniqueness against the agent's _seen_commands set without touching
    // the command router.
    const nonce = Date.now().toString(36);

    const batch = db.batch();
    for (const machineId of targets) {
      const pendingRef = db
        .collection('sites')
        .doc(site.siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('pending');
      const cmdId = `roost_resync_${roostId}_${versionId}_${nonce}`;
      batch.set(
        pendingRef,
        {
          [cmdId]: {
            type: 'sync_pull',
            site_id: site.siteId,
            roost_id: roostId,
            version_id: versionId,
            version_url: versionUrl,
            extract_root: extractRoot,
            queued_at: FieldValue.serverTimestamp(),
            resync: true,
            resync_requested_by: auth.userId,
          },
        },
        { merge: true },
      );

      // Clear stale target_state so the UI resets immediately rather than
      // lingering on "failed" until the agent writes its first new report.
      const tsRef = roostRef.collection('target_state').doc(machineId);
      batch.delete(tsRef);
    }

    // Drop the prior rollout doc so the fanout state machine doesn't
    // treat the resync reports as belated arrivals for an aborted wave.
    const rolloutRef = roostRef.collection('rollouts').doc(versionId);
    batch.delete(rolloutRef);

    // Stamp the roost doc for audit + so the UI's `updatedAt` reflects
    // the resync. This update does NOT change currentVersionId so it
    // won't re-trigger `onRoostWritten`.
    batch.set(
      roostRef,
      {
        resyncedAt: FieldValue.serverTimestamp(),
        resyncedBy: auth.userId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();

    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: roostId,
      attributes: {
        verb: 'resync',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        versionId,
        targetCount: targets.length,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json({ resynced: targets.length, targets }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/resync');
  }
}
