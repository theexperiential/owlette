/**
 * POST /api/installer/upload
 *
 * Step 1 of two-step upload: request a signed upload URL. The client then
 * uploads the binary directly to Firebase Storage using the returned URL.
 *
 * PUT  /api/installer/upload
 *
 * Step 2 (finalize): server verifies the file is in Storage, computes
 * checksum if the client didn't provide one, writes
 * `installer_metadata/data/versions/{version}` (and optionally the
 * `installer_metadata/latest` pointer).
 *
 * Auth (both verbs):
 *   - api key with `installer=*:write` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Idempotency: required on both POST and PUT. Same Idempotency-Key + body
 * within 24h replays the cached response.
 *
 * api-sprint wave 1 track 1B (installer-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const SIGNED_URL_EXPIRY_MINUTES = 15;
const IS_E2E = process.env.OWLETTE_E2E === '1';

interface UploadStartBody {
  version?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  releaseNotes?: unknown;
  setAsLatest?: unknown;
}

interface UploadFinalizeBody {
  uploadId?: unknown;
  checksum_sha256?: unknown;
}

/* --------------------------------------------------------------------- */
/*  POST — request signed upload URL                                     */
/* --------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'write');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as UploadStartBody;

        if (typeof body.version !== 'string' || !VERSION_REGEX.test(body.version)) {
          return problemValidation('version is required and must match X.Y.Z', {
            'body.version': ['must be a semver string like "2.2.1"'],
          });
        }
        const version = body.version;

        if (
          typeof body.fileName !== 'string' ||
          !body.fileName.toLowerCase().endsWith('.exe')
        ) {
          return problemValidation('fileName is required and must end with .exe', {
            'body.fileName': ['must be a string ending in .exe'],
          });
        }
        const fileName = body.fileName;

        if (
          body.contentType !== undefined &&
          typeof body.contentType !== 'string'
        ) {
          return problemValidation('contentType must be a string when provided', {
            'body.contentType': ['must be a string'],
          });
        }
        const contentType =
          (typeof body.contentType === 'string' && body.contentType) ||
          'application/octet-stream';

        if (
          body.releaseNotes !== undefined &&
          body.releaseNotes !== null &&
          typeof body.releaseNotes !== 'string'
        ) {
          return problemValidation('releaseNotes must be a string when provided', {
            'body.releaseNotes': ['must be a string or null'],
          });
        }
        const releaseNotes =
          typeof body.releaseNotes === 'string' ? body.releaseNotes : null;

        if (
          body.setAsLatest !== undefined &&
          typeof body.setAsLatest !== 'boolean'
        ) {
          return problemValidation('setAsLatest must be a boolean when provided', {
            'body.setAsLatest': ['must be boolean'],
          });
        }
        const setAsLatest = body.setAsLatest !== false; // default true

        const db = getAdminDb();
        const storage = getAdminStorage();
        const bucket = storage.bucket();
        const storagePath = `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;
        const file = bucket.file(storagePath);

        const expiresAt = new Date(
          Date.now() + SIGNED_URL_EXPIRY_MINUTES * 60 * 1000,
        );
        const uploadUrl = IS_E2E
          ? `http://127.0.0.1:9199/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(storagePath)}?uploadType=media`
          : (
              await file.getSignedUrl({
                action: 'write',
                version: 'v4',
                expires: expiresAt,
                contentType,
              })
            )[0];

        const uploadId = randomUUID();
        await db.collection('installer_uploads').doc(uploadId).set({
          version,
          fileName,
          storagePath,
          userId: auth.userId,
          releaseNotes,
          setAsLatest,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromDate(expiresAt),
        });

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: '/api/installer/upload',
            method: 'POST',
            verb: 'upload_initiated',
            uploadId,
            setAsLatest,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uploadUrl,
            uploadId,
            storagePath,
            expiresAt: expiresAt.toISOString(),
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'installer/upload:POST');
  }
}

/* --------------------------------------------------------------------- */
/*  PUT — finalize upload                                                */
/* --------------------------------------------------------------------- */

export async function PUT(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'write');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as UploadFinalizeBody;

        if (typeof body.uploadId !== 'string' || body.uploadId.length === 0) {
          return problemValidation('uploadId is required', {
            'body.uploadId': ['must be a non-empty string'],
          });
        }
        const uploadId = body.uploadId;

        let providedChecksum: string | null = null;
        if (body.checksum_sha256 !== undefined && body.checksum_sha256 !== null) {
          if (
            typeof body.checksum_sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(body.checksum_sha256)
          ) {
            return problemValidation(
              'checksum_sha256 must be a 64-char lowercase hex string when provided',
              { 'body.checksum_sha256': ['must be a sha-256 hex digest'] },
            );
          }
          providedChecksum = body.checksum_sha256.toLowerCase();
        }

        const db = getAdminDb();

        const uploadDoc = await db
          .collection('installer_uploads')
          .doc(uploadId)
          .get();
        if (!uploadDoc.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'upload record not found',
            status: 404,
            detail: `no pending upload with id ${uploadId}`,
            instance: '/api/installer/upload',
          });
        }

        const uploadData = uploadDoc.data()!;
        if (uploadData.status !== 'pending') {
          return problem({
            type: ProblemType.Conflict,
            title: 'upload already finalized',
            status: 409,
            detail: `upload ${uploadId} is already ${uploadData.status}`,
            instance: '/api/installer/upload',
            code: 'upload_not_pending',
          });
        }

        const expiresAtMs =
          (typeof uploadData.expiresAt?.toMillis === 'function'
            ? uploadData.expiresAt.toMillis()
            : Number(uploadData.expiresAt)) || 0;
        if (Date.now() > expiresAtMs) {
          await db
            .collection('installer_uploads')
            .doc(uploadId)
            .update({ status: 'expired' });
          return problem({
            type: ProblemType.PreconditionFailed,
            title: 'upload expired',
            status: 410,
            detail: 'upload window expired; request a fresh signed url',
            instance: '/api/installer/upload',
            code: 'upload_expired',
          });
        }

        const storage = getAdminStorage();
        const bucket = storage.bucket();
        const file = bucket.file(uploadData.storagePath);

        const [exists] = await file.exists();
        if (!exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'binary not in storage',
            status: 404,
            detail:
              'the signed url was issued but no object was uploaded; complete step 2 before finalizing',
            instance: '/api/installer/upload',
            code: 'binary_missing',
          });
        }

        const [metadata] = await file.getMetadata();
        const fileSize = parseInt(metadata.size as string, 10) || 0;

        let finalChecksum = providedChecksum;
        if (!finalChecksum) {
          const [fileBuffer] = await file.download();
          finalChecksum = createHash('sha256').update(fileBuffer).digest('hex');
        }

        const downloadExpiry = new Date('2030-01-01');
        const [downloadUrl] = await file.getSignedUrl({
          action: 'read',
          expires: downloadExpiry,
        });

        const version = uploadData.version as string;
        const now = Date.now();

        const versionData = {
          version,
          download_url: downloadUrl,
          checksum_sha256: finalChecksum,
          release_notes: uploadData.releaseNotes ?? null,
          file_size: fileSize,
          uploaded_at: now,
          release_date: Timestamp.fromMillis(now),
          uploaded_by: uploadData.userId,
        };

        await db
          .collection('installer_metadata')
          .doc('data')
          .collection('versions')
          .doc(version)
          .set(versionData);

        if (uploadData.setAsLatest) {
          await db
            .collection('installer_metadata')
            .doc('latest')
            .set({
              ...versionData,
              release_date: new Date(now).toISOString(),
            });
        }

        await db
          .collection('installer_uploads')
          .doc(uploadId)
          .update({
            status: 'completed',
            completedAt: now,
            file_size: fileSize,
          });

        emitMutation({
          kind: 'installer_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: version,
          attributes: {
            endpoint: '/api/installer/upload',
            method: 'PUT',
            verb: 'upload_finalized',
            uploadId,
            setAsLatest: uploadData.setAsLatest === true,
            file_size: fileSize,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            version,
            download_url: downloadUrl,
            checksum_sha256: finalChecksum,
            file_size: fileSize,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'installer/upload:PUT');
  }
}
