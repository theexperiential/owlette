/**
 * POST /api/roosts/{roostId}/deploy
 *
 * input:  {
 *   siteId: string,
 *   manifestId?: string,        // default: current manifest
 *   machines?: string[],         // default: roost.targets
 *   scheduleAt?: string,         // iso8601 — stub (2026-04-23: not yet wired to a scheduler)
 *   dryRun?: boolean,
 * }
 * output: {
 *   rolloutId: string,           // = manifestId (keyed by manifest per existing arch)
 *   manifestId, siteId, roostId,
 *   stage: 'canary' | 'scheduled',
 *   canary: string[], fleet: string[],
 *   extractRoot: string,
 *   manifestUrl: string,
 *   alreadyRunning?: boolean,    // idempotent re-trigger hit
 *   dryRun?: boolean,
 *   scheduled?: { at: string, warning: string },
 * }
 *
 * Honors the optional `Idempotency-Key` header by returning a cached
 * response shape if the same manifestId rollout already exists (per-
 * manifest idempotency is natively provided by the rollout doc key).
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
import { getAdminDb } from '@/lib/firebase-admin';
import {
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
  manifestId?: unknown;
  machines?: unknown;
  scheduleAt?: unknown;
  dryRun?: unknown;
}

const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';
const CANARY_FRACTION = 0.1;
const CANARY_MIN = 1;
const CANARY_MAX = 50;

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

    let explicitManifestId: string | undefined;
    if (body.manifestId !== undefined) {
      if (typeof body.manifestId !== 'string') {
        return problemValidation('manifestId must be a string when provided', {
          'body.manifestId': ['must be a string'],
        });
      }
      const mErr = validateResourceId(body.manifestId, 'manifestId');
      if (mErr) return mErr;
      explicitManifestId = body.manifestId;
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

    const manifestId = explicitManifestId ?? (typeof roost.currentManifestId === 'string' ? roost.currentManifestId : null);
    if (!manifestId) {
      return problemValidation(
        'manifestId is required — roost has no currentManifestId to fall back on',
        { 'body.manifestId': ['no current manifest; specify manifestId explicitly'] },
      );
    }

    // Resolve manifestUrl for the target manifest. If it's the current one,
    // roost.manifestUrl is authoritative; otherwise read the manifests/{id} doc.
    let manifestUrl: string | null = null;
    if (manifestId === roost.currentManifestId && typeof roost.manifestUrl === 'string') {
      manifestUrl = roost.manifestUrl;
    } else {
      const manifestSnap = await roostRef.collection('manifests').doc(manifestId).get();
      if (!manifestSnap.exists) {
        return problem({
          type: ProblemType.NotFound,
          title: 'manifest not found',
          status: 404,
          detail: `manifest ${manifestId} is not in this roost's history`,
          instance: `/api/roosts/${roostId}/deploy`,
        });
      }
      manifestUrl = (manifestSnap.data()?.manifestUrl as string | undefined) ?? null;
    }
    if (!manifestUrl) {
      return problem({
        type: ProblemType.Conflict,
        title: 'manifest has no url',
        status: 409,
        detail: 'the manifest pointer exists but its R2 url is missing; cannot fan out without it',
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

    const { canary, fleet } = splitCanary(machines, manifestId);

    const rolloutRef = roostRef.collection('rollouts').doc(manifestId);

    // Dry-run short-circuits BEFORE any writes.
    if (dryRun) {
      return applyAuthDeprecations(
        NextResponse.json({
          rolloutId: manifestId,
          manifestId,
          siteId: site.siteId,
          roostId,
          stage: scheduleAtMs ? 'scheduled' : 'canary',
          canary,
          fleet,
          extractRoot,
          manifestUrl,
          dryRun: true,
        }),
        auth.scopeCheck,
      );
    }

    // Idempotent re-trigger: if a rollout for this manifest already exists
    // and isn't terminal, return it with alreadyRunning=true. Don't
    // re-queue commands (the existing canary still owns that wave).
    const existingRollout = await rolloutRef.get();
    if (existingRollout.exists) {
      const existing = existingRollout.data() ?? {};
      const stage = typeof existing.stage === 'string' ? existing.stage : 'canary';
      if (stage !== 'complete' && stage !== 'aborted') {
        return applyAuthDeprecations(
          NextResponse.json({
            rolloutId: manifestId,
            manifestId,
            siteId: site.siteId,
            roostId,
            stage,
            canary: Array.isArray(existing.canary) ? existing.canary : canary,
            fleet: Array.isArray(existing.fleet) ? existing.fleet : fleet,
            extractRoot: typeof existing.extractRoot === 'string' ? existing.extractRoot : extractRoot,
            manifestUrl: typeof existing.manifestUrl === 'string' ? existing.manifestUrl : manifestUrl,
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
      manifestId,
      manifestUrl,
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
        const cmdId = `roost_sync_${roostId}_${manifestId}`;
        batch.set(
          pendingRef,
          {
            [cmdId]: {
              type: 'sync_pull',
              site_id: site.siteId,
              folder_id: roostId,
              manifest_id: manifestId,
              manifest_url: manifestUrl,
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
          rolloutId: manifestId,
          manifestId,
          siteId: site.siteId,
          roostId,
          stage: scheduled ? 'scheduled' : 'canary',
          canary,
          fleet,
          extractRoot,
          manifestUrl,
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
        { status: 201 },
      ),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/deploy:POST');
  }
}

/** Inline canary split — 10% of machines, floor 1, cap 50, lexicographic for determinism. */
function splitCanary(machineIds: readonly string[], manifestId: string): {
  canary: string[];
  fleet: string[];
} {
  void manifestId;
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
