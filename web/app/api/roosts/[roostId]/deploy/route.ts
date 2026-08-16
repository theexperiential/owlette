/**
 * POST /api/roosts/{roostId}/deploy
 *
 * input:  {
 *   siteId: string,
 *   versionId?: string,          // default: current version
 *   machines?: string[],         // default: roost.targets
 *   scheduleAt?: string,         // iso8601 — stub (2026-04-23: not yet wired to a scheduler)
 *   dryRun?: boolean,
 * }
 * output: {
 *   rolloutId: string,           // = versionId (keyed by version per existing arch)
 *   versionId, siteId, roostId,
 *   stage: 'canary' | 'scheduled',
 *   canary: string[], fleet: string[],
 *   extractRoot: string,
 *   versionUrl: string,
 *   alreadyRunning?: boolean,    // idempotent re-trigger hit
 *   dryRun?: boolean,
 *   scheduled?: { at: string, warning: string },
 * }
 *
 * Returns 202 Accepted once the rollout is queued.
 *
 * Honors the optional `Idempotency-Key` header by returning a cached
 * response shape if the same versionId rollout already exists (per-
 * version idempotency is natively provided by the rollout doc key).
 *
 * roost public api wave 3.3.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
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

interface DeployBody {
  siteId?: unknown;
  versionId?: unknown;
  machines?: unknown;
  scheduleAt?: unknown;
  dryRun?: unknown;
}

const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';
const CANARY_FRACTION = 0.1;
const CANARY_MIN = 1;
const CANARY_MAX = 50;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as DeployBody;

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'deploy');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'replay' || idem.mode === 'mismatch') {
      return idem.response;
    }

    const dryRun = body.dryRun === true;

    let explicitVersionId: string | undefined;
    if (body.versionId !== undefined) {
      if (typeof body.versionId !== 'string') {
        return problemValidation('versionId must be a string when provided', {
          'body.versionId': ['must be a string'],
        });
      }
      const mErr = validateResourceId(body.versionId, 'versionId');
      if (mErr) return mErr;
      explicitVersionId = body.versionId;
    }

    let explicitMachines: string[] | undefined;
    if (body.machines !== undefined) {
      if (!Array.isArray(body.machines) || body.machines.some((m) => typeof m !== 'string' || m.length === 0)) {
        return problemValidation('machines must be an array of non-empty machineId strings', {
          'body.machines': ['must be string[]'],
        });
      }
      explicitMachines = [...new Set(body.machines as string[])];
      if (explicitMachines.length === 0) {
        return problemValidation('machines must not be empty when provided', {
          'body.machines': ['must be non-empty when provided'],
        });
      }
    }

    let scheduleAtMs: number | undefined;
    if (body.scheduleAt !== undefined) {
      if (typeof body.scheduleAt !== 'string') {
        return problemValidation('scheduleAt must be an ISO-8601 string when provided', {
          'body.scheduleAt': ['must be iso8601 string'],
        });
      }
      const parsedAt = Date.parse(body.scheduleAt);
      if (Number.isNaN(parsedAt)) {
        return problemValidation('scheduleAt could not be parsed as ISO-8601', {
          'body.scheduleAt': ['invalid iso8601'],
        });
      }
      scheduleAtMs = parsedAt;
    }

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);
    const roostSnap = await roostRef.get();
    if (!roostSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/deploy`,
      });
    }
    const roost = roostSnap.data() ?? {};
    if (roost.deletedAt) {
      return problem({
        type: ProblemType.Conflict,
        title: 'roost deleted',
        status: 409,
        detail: `roost ${roostId} is soft-deleted; undelete before deploying`,
        instance: `/api/roosts/${roostId}/deploy`,
      });
    }

    const versionId = explicitVersionId ?? (typeof roost.currentVersionId === 'string' ? roost.currentVersionId : null);
    if (!versionId) {
      return problemValidation(
        'versionId is required — roost has no currentVersionId to fall back on',
        { 'body.versionId': ['no current version; specify versionId explicitly'] },
      );
    }

    // Resolve versionUrl for the target version. If it's the current one,
    // roost.versionUrl is authoritative; otherwise read the versions/{id} doc.
    let versionUrl: string | null = null;
    if (versionId === roost.currentVersionId && typeof roost.versionUrl === 'string') {
      versionUrl = roost.versionUrl;
    } else {
      const versionSnap = await roostRef.collection('versions').doc(versionId).get();
      if (!versionSnap.exists) {
        return problem({
          type: ProblemType.NotFound,
          title: 'version not found',
          status: 404,
          detail: `version ${versionId} is not in this roost's history`,
          instance: `/api/roosts/${roostId}/deploy`,
          code: 'version_not_found',
        });
      }
      versionUrl = (versionSnap.data()?.versionUrl as string | undefined) ?? null;
    }
    if (!versionUrl) {
      return problem({
        type: ProblemType.Conflict,
        title: 'version has no url',
        status: 409,
        detail: 'the version pointer exists but its R2 url is missing; cannot fan out without it',
        instance: `/api/roosts/${roostId}/deploy`,
      });
    }

    const roostTargets = Array.isArray(roost.targets) ? (roost.targets as string[]) : [];
    const machines = explicitMachines ?? roostTargets;
    if (machines.length === 0) {
      return problemValidation(
        'no target machines — roost has empty targets[] and no machines[] override provided',
        { targets: ['empty'] },
      );
    }

    const extractRoot =
      typeof roost.extractPath === 'string' && roost.extractPath.trim().length > 0
        ? roost.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    const { canary, fleet } = splitCanary(machines, versionId);

    const rolloutRef = roostRef.collection('rollouts').doc(versionId);

    // Dry-run short-circuits BEFORE any writes.
    if (dryRun) {
      return applyAuthDeprecations(
        NextResponse.json({
          rolloutId: versionId,
          versionId,
          siteId: site.siteId,
          roostId,
          stage: scheduleAtMs ? 'scheduled' : 'canary',
          canary,
          fleet,
          extractRoot,
          versionUrl,
          dryRun: true,
        }),
        auth.scopeCheck,
      );
    }

    // Idempotent re-trigger: if a rollout for this version already exists
    // and isn't terminal, return it with alreadyRunning=true. Don't
    // re-queue commands (the existing canary still owns that wave).
    const existingRollout = await rolloutRef.get();
    if (existingRollout.exists) {
      const existing = existingRollout.data() ?? {};
      const stage = typeof existing.stage === 'string' ? existing.stage : 'canary';
      if (stage !== 'complete' && stage !== 'aborted') {
        return applyAuthDeprecations(
          NextResponse.json({
            rolloutId: versionId,
            versionId,
            siteId: site.siteId,
            roostId,
            stage,
            canary: Array.isArray(existing.canary) ? existing.canary : canary,
            fleet: Array.isArray(existing.fleet) ? existing.fleet : fleet,
            extractRoot: typeof existing.extractRoot === 'string' ? existing.extractRoot : extractRoot,
            versionUrl: typeof existing.versionUrl === 'string' ? existing.versionUrl : versionUrl,
            alreadyRunning: true,
          }),
          auth.scopeCheck,
        );
      }
      // Terminal stage — allow a fresh rollout by overwriting below.
    }

    const batch = db.batch();
    const scheduled = typeof scheduleAtMs === 'number' && scheduleAtMs > Date.now() + 60_000;

    batch.set(rolloutRef, {
      stage: scheduled ? 'scheduled' : 'canary',
      versionId,
      versionUrl,
      extractRoot,
      canary,
      fleet,
      startedAt: FieldValue.serverTimestamp(),
      triggeredBy: auth.userId,
      ...(scheduled && typeof scheduleAtMs === 'number'
        ? { scheduledAt: Timestamp.fromMillis(scheduleAtMs) }
        : {}),
      ...(explicitMachines ? { targetsOverride: explicitMachines } : {}),
    });

    if (!scheduled) {
      // Queue sync_pull commands for the canary wave. Matches the existing
      // fan-out trigger's write shape so agents pick them up without
      // protocol changes.
      for (const machineId of canary) {
        const pendingRef = db
          .collection('sites')
          .doc(site.siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');
        const cmdId = `roost_sync_${roostId}_${versionId}`;
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
            },
          },
          { merge: true },
        );
      }
    }

    await batch.commit();

    const response = applyAuthDeprecations(
      NextResponse.json(
        {
          rolloutId: versionId,
          versionId,
          siteId: site.siteId,
          roostId,
          stage: scheduled ? 'scheduled' : 'canary',
          canary,
          fleet,
          extractRoot,
          versionUrl,
          ...(scheduled && typeof scheduleAtMs === 'number'
            ? {
                scheduled: {
                  at: new Date(scheduleAtMs).toISOString(),
                  warning:
                    'scheduled rollouts are stored but will not auto-fire until the scheduler sweep ships (wave 4)',
                },
              }
            : {}),
        },
        { status: 202 },
      ),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: versionId,
      attributes: {
        verb: 'deploy',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        roostId,
        versionId,
        stage: scheduled ? 'scheduled' : 'canary',
        targetCount: machines.length,
        canaryCount: canary.length,
        scheduled,
      },
    });
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/deploy:POST');
  }
}

/** Inline canary split — 10% of machines, floor 1, cap 50, lexicographic for determinism. */
function splitCanary(machineIds: readonly string[], versionId: string): {
  canary: string[];
  fleet: string[];
} {
  void versionId;
  if (machineIds.length === 0) return { canary: [], fleet: [] };
  const canarySize = Math.max(
    CANARY_MIN,
    Math.min(CANARY_MAX, Math.ceil(machineIds.length * CANARY_FRACTION)),
  );
  const sorted = [...machineIds].sort();
  return {
    canary: sorted.slice(0, canarySize),
    fleet: sorted.slice(canarySize),
  };
}
