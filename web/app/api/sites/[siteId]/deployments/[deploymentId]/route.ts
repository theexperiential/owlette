/**
 * GET /api/sites/{siteId}/deployments/{deploymentId}
 *
 * Returns full deployment detail incl. per-target status array.
 * Requires `site=<id>:read`.
 *
 * api-sprint wave 1 — track 1A (installer-deploys-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string; deploymentId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, deploymentId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const deploymentRef = db
      .collection('sites')
      .doc(siteId)
      .collection('deployments')
      .doc(deploymentId);
    const snap = await deploymentRef.get();

    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `deployment ${deploymentId} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/deployments/${deploymentId}`,
      });
    }

    const data = snap.data() ?? {};

    return applyAuthDeprecations(
      NextResponse.json({
        id: snap.id,
        siteId,
        name: typeof data.name === 'string' ? data.name : 'Unnamed Deployment',
        installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
        installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
        silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
        verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
        sha256_checksum: typeof data.sha256_checksum === 'string' ? data.sha256_checksum : null,
        parallel_install: data.parallel_install === true,
        targets: Array.isArray(data.targets) ? data.targets : [],
        status: typeof data.status === 'string' ? data.status : 'pending',
        createdAt: timestampToIso(data.createdAt),
        completedAt: timestampToIso(data.completedAt),
        updatedAt: timestampToIso(data.updatedAt),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]:GET');
  }
}
