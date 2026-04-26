import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { parseJsonBody } from '@/app/api/_shared';
import {
  InstallerVersionDeletedError,
  InstallerVersionNotFoundError,
  setLatestInstaller,
} from '@/lib/actions/setLatestInstaller.server';
import { InstallerValidationError } from '@/lib/actions/uploadInstaller.server';

/**
 * GET /api/admin/installer/latest
 *
 * Get the latest installer metadata (version, download URL, checksum, release notes).
 * Global endpoint — not site-scoped.
 *
 * security-boundary-migration wave 3.11: GET is wrapped read-scope, while
 * PUT is write-gated by `authorizedPlatformHandler({ capability:
 * 'INSTALLER_MANAGE' })` and delegates the metadata mutation to the
 * `setLatestInstaller` action core.
 */
export const GET = authorizedPlatformHandler({
  capability: 'INSTALLER_MANAGE',
  targetKind: 'installer',
  apiKeyScope: { resource: 'installer', permission: 'read' },
})(async () => {
  try {
    const db = getAdminDb();
    const latestDoc = await db.collection('installer_metadata').doc('latest').get();

    if (!latestDoc.exists) {
      return NextResponse.json(
        { error: 'No installer metadata found' },
        { status: 404 },
      );
    }

    const data = latestDoc.data()!;

    return NextResponse.json({
      success: true,
      installer: {
        version: data.version || null,
        download_url: data.download_url || null,
        checksum_sha256: data.checksum_sha256 || null,
        release_notes: data.release_notes || null,
        file_size: data.file_size || null,
        uploaded_at: data.uploaded_at || data.release_date || null,
      },
    });
  } catch (error: unknown) {
    return apiError(error, 'admin/installer/latest');
  }
});

interface PutBody {
  version?: unknown;
}

/**
 * PUT /api/admin/installer/latest
 *
 * Promote an existing installer version to the latest pointer.
 */
export const PUT = authorizedPlatformHandler({
  capability: 'INSTALLER_MANAGE',
  targetKind: 'installer',
  apiKeyScope: { resource: 'installer', permission: 'admin' },
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const body = (parsed.body ?? {}) as PutBody;
    if (typeof body.version !== 'string') {
      return problemValidation('field `version` is required and must be a string', {
        'body.version': ['required string'],
      });
    }

    try {
      const result = await setLatestInstaller({
        actor: ctx.actor,
        version: body.version,
      });
      return NextResponse.json({
        version: result.version,
        latest: result.latest,
      });
    } catch (err) {
      if (err instanceof InstallerValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      if (err instanceof InstallerVersionNotFoundError) {
        return problemNotFound(`installer version ${err.version} does not exist`);
      }
      if (err instanceof InstallerVersionDeletedError) {
        return problem({
          type: ProblemType.Conflict,
          title: 'version is deleted',
          status: 409,
          detail: `installer version ${err.version} is soft-deleted; restore it before promoting`,
          code: 'version_deleted',
        });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'admin/installer/latest:PUT');
  }
});
