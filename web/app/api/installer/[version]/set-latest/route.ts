/**
 * POST /api/installer/{version}/set-latest
 *
 * Update the `installer_metadata/latest` pointer to the given version.
 * Atomic Firestore transaction — refuses if the version doesn't exist or
 * is soft-deleted.
 *
 * Auth:
 *   - api key with `installer=*:admin` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Idempotency: required. Re-issuing the same Idempotency-Key with the
 * same body within 24h returns the cached response.
 *
 * api-sprint wave 1 track 1B (installer-api).
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
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

interface RouteParams {
  params: Promise<{ version: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { version } = await params;
    if (!VERSION_REGEX.test(version)) {
      return problemValidation('version must match X.Y.Z', {
        'path.version': ['must be a semver string like "2.2.1"'],
      });
    }

    // Read + discard body so idempotency body-hashing is consistent even
    // when callers send `{}` or no body. Also rejects malformed json early.
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'admin');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const db = getAdminDb();
        const versionRef = db
          .collection('installer_metadata')
          .doc('data')
          .collection('versions')
          .doc(version);
        const latestRef = db.collection('installer_metadata').doc('latest');

        const result = await db.runTransaction(async (tx) => {
          const versionSnap = await tx.get(versionRef);
          if (!versionSnap.exists) {
            return { kind: 'not_found' as const };
          }
          const data = versionSnap.data() ?? {};
          if (typeof data.deletedAt === 'number') {
            return { kind: 'deleted' as const };
          }

          const now = Date.now();
          const latestData = {
            version: data.version || version,
            download_url: data.download_url ?? null,
            checksum_sha256: data.checksum_sha256 ?? null,
            release_notes: data.release_notes ?? null,
            file_size: data.file_size ?? null,
            uploaded_at: data.uploaded_at ?? null,
            uploaded_by: data.uploaded_by ?? null,
            release_date: new Date(now).toISOString(),
            promoted_at: now,
            promoted_by: auth.userId,
          };
          tx.set(latestRef, latestData);
          return { kind: 'set' as const, latestData };
        });

        if (result.kind === 'not_found') {
          return problem({
            type: ProblemType.NotFound,
            title: 'version not found',
            status: 404,
            detail: `installer version ${version} does not exist`,
            instance: `/api/installer/${version}/set-latest`,
          });
        }

        if (result.kind === 'deleted') {
          return problem({
            type: ProblemType.Conflict,
            title: 'version is deleted',
            status: 409,
            detail: `installer version ${version} is soft-deleted; restore it before promoting`,
            instance: `/api/installer/${version}/set-latest`,
            code: 'version_deleted',
          });
        }

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: `/api/installer/${version}/set-latest`,
            method: 'POST',
            verb: 'set_latest',
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            version,
            latest: result.latestData,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'installer/[version]/set-latest:POST');
  }
}
