/**
 * GET /api/installer/latest
 *
 * Return the current latest installer metadata. This is the authenticated
 * management API used by the CLI and admin dashboard; the public unauthenticated
 * download permalink remains GET /download.
 *
 * Auth:
 *   - api key with `installer=*:read` scope (superadmin-only at minting)
 *   - session / id-token from a user where `users/{uid}.role === 'superadmin'`
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  installerVersionResponse,
  type InstallerVersionRecord,
} from '@/lib/installerVersionResponse.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../_shared';

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'installer', 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const latestRef = db.collection('installer_metadata').doc('latest');
    const latestSnap = await latestRef.get();
    const latestData = latestSnap.exists
      ? (latestSnap.data() as InstallerVersionRecord | undefined)
      : undefined;
    const version =
      typeof latestData?.version === 'string' && latestData.version.length > 0
        ? latestData.version
        : null;

    if (!version) {
      return latestMissing();
    }

    const versionSnap = await db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions')
      .doc(version)
      .get();

    if (!versionSnap.exists) {
      return latestMissing();
    }

    const versionData = versionSnap.data() as InstallerVersionRecord;
    if (typeof versionData.deletedAt === 'number') {
      return latestMissing();
    }

    const body = installerVersionResponse(version, {
      ...versionData,
      promoted_at: latestData?.promoted_at,
      promoted_by: latestData?.promoted_by,
      release_date: latestData?.release_date ?? versionData.release_date,
    });

    return applyAuthDeprecations(NextResponse.json(body), auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'installer/latest:GET');
  }
}

function latestMissing() {
  return problem({
    type: ProblemType.NotFound,
    title: 'latest installer not found',
    status: 404,
    detail: 'no active latest installer is available',
    instance: '/api/installer/latest',
    code: 'latest_installer_not_found',
  });
}
