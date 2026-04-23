/**
 * DELETE /api/roosts/{roostId}
 *      input:  siteId via ?siteId=... query string (DELETE has no body per RFC,
 *              and embedding siteId in the path would double-encode the URL shape)
 *      output: { deleted: true, roostId, manifestsDeleted }
 *
 * Deletes the roost doc + its manifests subcollection in a batch.
 * Does NOT delete content-addressed chunks from R2 — chunk GC (wave 2b.4)
 * owns that via its mark-and-sweep. Manifest JSON bodies in R2 are also
 * left for GC to reclaim; the pointer is gone so nothing references them.
 *
 * Target-state subcollection (per-machine progress reports) is also purged
 * so a future roost reusing the same id starts clean.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  validateResourceId,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const siteId = request.nextUrl.searchParams.get('siteId');
    if (!siteId) {
      return problemValidation('siteId query param required', {
        'query.siteId': ['required'],
      });
    }
    const siteIdError = validateResourceId(siteId, 'siteId');
    if (siteIdError) return siteIdError;

    const scopeError = await requireSiteScope(auth.userId, siteId);
    if (scopeError) return scopeError;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId);

    const roostSnap = await roostRef.get();
    if (!roostSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${siteId}`,
        instance: `/api/roosts/${roostId}`,
      });
    }

    // Delete subcollection docs in chunks. BulkWriter handles batching +
    // retries internally; 500 is the firestore-per-commit cap.
    const bulk = db.bulkWriter();

    let manifestsDeleted = 0;
    const manifestsSnap = await roostRef.collection('manifests').get();
    for (const doc of manifestsSnap.docs) {
      bulk.delete(doc.ref);
      manifestsDeleted++;
    }

    const targetStateSnap = await roostRef.collection('target_state').get();
    for (const doc of targetStateSnap.docs) {
      bulk.delete(doc.ref);
    }

    bulk.delete(roostRef);
    await bulk.close();

    return NextResponse.json({
      deleted: true,
      roostId,
      manifestsDeleted,
    });
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/DELETE');
  }
}
