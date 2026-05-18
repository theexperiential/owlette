/**
 * GET /api/roosts/{roostId}/deployments/{rolloutId}?siteId=...
 *     → Rollout detail with per-machine state pulled from target_state
 *       subcollection. canaryStatus / fleetStatus include the reported
 *       status for each machine in the wave (pending if unreported).
 *
 * roost public api wave 3.3.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string; rolloutId: string }>;
}

interface MachineStatus {
  machineId: string;
  status: string;
  reportedVersionId: string | null;
  reportedAt: string | null;
}

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId, rolloutId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;
    const rolloutError = validateResourceId(rolloutId, 'rolloutId');
    if (rolloutError) return rolloutError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const rolloutSnap = await roostRef.collection('rollouts').doc(rolloutId).get();
    if (!rolloutSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'rollout not found',
        status: 404,
        detail: `rollout ${rolloutId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/deployments/${rolloutId}`,
      });
    }
    const rollout = rolloutSnap.data() ?? {};
    const versionId =
      typeof rollout.versionId === 'string' ? rollout.versionId : rolloutId;
    const canary = Array.isArray(rollout.canary) ? (rollout.canary as string[]) : [];
    const fleet = Array.isArray(rollout.fleet) ? (rollout.fleet as string[]) : [];

    // Fetch target_state for every machine in the wave. target_state is
    // per-machine, per-roost (not per-version), so filter by reported
    // versionId to scope reports to this specific rollout.
    const allMachines = [...new Set([...canary, ...fleet])];
    const targetStateCol = roostRef.collection('target_state');
    const stateSnaps = await Promise.all(
      allMachines.map((m) => targetStateCol.doc(m).get()),
    );
    const stateByMachine = new Map<string, MachineStatus>();
    for (let i = 0; i < allMachines.length; i++) {
      const machineId = allMachines[i];
      const snap = stateSnaps[i];
      if (!snap.exists) {
        stateByMachine.set(machineId, {
          machineId,
          status: 'pending',
          reportedVersionId: null,
          reportedAt: null,
        });
        continue;
      }
      const data = snap.data() ?? {};
      const reportedVersionId =
        typeof data.reportedVersionId === 'string' ? data.reportedVersionId : null;
      // If the machine's most-recent report is for a different version,
      // treat this rollout's wave slot as still pending (the machine might
      // have already moved on to a newer version since).
      const onThisRollout = reportedVersionId === versionId;
      stateByMachine.set(machineId, {
        machineId,
        status: onThisRollout
          ? typeof data.status === 'string'
            ? data.status
            : 'pending'
          : 'pending',
        reportedVersionId,
        reportedAt: timestampToIso(data.reportedAt),
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        rolloutId,
        roostId,
        siteId: site.siteId,
        versionId,
        versionUrl: typeof rollout.versionUrl === 'string' ? rollout.versionUrl : null,
        extractRoot: typeof rollout.extractRoot === 'string' ? rollout.extractRoot : null,
        stage: typeof rollout.stage === 'string' ? rollout.stage : 'unknown',
        triggeredBy: rollout.triggeredBy ?? null,
        startedAt: timestampToIso(rollout.startedAt),
        completedAt: timestampToIso(rollout.completedAt),
        abortedAt: timestampToIso(rollout.abortedAt),
        abortReason: rollout.abortReason ?? null,
        scheduledAt: timestampToIso(rollout.scheduledAt),
        targetsOverride: Array.isArray(rollout.targetsOverride) ? rollout.targetsOverride : null,
        canary,
        fleet,
        canaryStatus: canary.map((m) => stateByMachine.get(m)!),
        fleetStatus: fleet.map((m) => stateByMachine.get(m)!),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/deployments/[rolloutId]:GET');
  }
}
