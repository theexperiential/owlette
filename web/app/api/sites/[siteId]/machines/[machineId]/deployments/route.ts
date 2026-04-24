/**
 * GET /api/sites/{siteId}/machines/{machineId}/deployments
 *      → Per-roost current state for a specific machine.
 *        For every roost in the site whose targets[] include this
 *        machine, returns the intended currentManifestId (from the
 *        roost doc) and the reportedManifestId + status (from the
 *        per-roost target_state/{machineId} subcollection doc).
 *
 * roost public api wave 3.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteRef = db.collection('sites').doc(siteId);

    // Find every roost on this site that targets this machine.
    // Firestore `array-contains` is native — one query, no full scan.
    const targetingRoostsSnap = await siteRef
      .collection('roosts')
      .where('targets', 'array-contains', machineId)
      .get();

    // For each matching roost, load its target_state/{machineId} doc in parallel.
    const perRoost = await Promise.all(
      targetingRoostsSnap.docs.map(async (roostDoc) => {
        const data = roostDoc.data();
        if (data.deletedAt) return null;
        const targetStateSnap = await roostDoc.ref
          .collection('target_state')
          .doc(machineId)
          .get();
        const ts = targetStateSnap.exists ? (targetStateSnap.data() ?? {}) : {};
        return {
          roostId: roostDoc.id,
          name: typeof data.name === 'string' ? data.name : roostDoc.id,
          currentManifestId: typeof data.currentManifestId === 'string' ? data.currentManifestId : null,
          previousManifestId: typeof data.previousManifestId === 'string' ? data.previousManifestId : null,
          extractPath: typeof data.extractPath === 'string' ? data.extractPath : null,
          reportedManifestId: typeof ts.reportedManifestId === 'string' ? ts.reportedManifestId : null,
          reportedStatus: typeof ts.status === 'string' ? ts.status : null,
          reportedAt: timestampToIso(ts.reportedAt),
        };
      }),
    );

    const deployments = perRoost.filter((r): r is NonNullable<typeof r> => r !== null);
    deployments.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        machineId,
        deployments,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines/[machineId]/deployments:GET');
  }
}
