import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { apiError } from '@/lib/apiErrorResponse';
import { problemValidation } from '@/lib/apiErrors';
import logger from '@/lib/logger';
import { uploadInstaller } from '@/lib/actions/uploadInstaller.server';

/**
 * security-boundary-migration wave 3.11: this route is now wrapped with
 * `authorizedPlatformHandler({ capability: 'INSTALLER_MANAGE' })`. The
 * 3-step upload flow (request signed URL → upload binary → finalize) is
 * preserved bit-for-bit per `.claude/CLAUDE.md` build-and-upload guide.
 *
 *   POST → step 1: returns a v4 signed upload URL + uploadId.
 *   PUT  → step 3: verifies the storage object, computes checksum, and
 *          delegates the metadata write to `uploadInstaller` action core.
 *
 * Rate limiting that previously came from `withRateLimit` is now provided
 * by the wrapper's `checkRateLimit` step (gated by
 * `rate_limit_enforcement` in `global/security_config`).
 */

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const SIGNED_URL_EXPIRY_MINUTES = 15;

interface PostBody {
  version?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  releaseNotes?: unknown;
  setAsLatest?: unknown;
}

/**
 * POST /api/admin/installer/upload
 *
 * Step 1 of two-step upload: Request a signed upload URL.
 * Client then uploads directly to Firebase Storage using this URL.
 *
 * Request body:
 *   version: string (semver, e.g. "2.2.1")
 *   fileName: string (must end with .exe)
 *   contentType?: string (default: application/octet-stream)
 *   releaseNotes?: string
 *   setAsLatest?: boolean (default: true)
 */
export const POST = authorizedPlatformHandler({
  capability: 'INSTALLER_MANAGE',
})(async (request: NextRequest, ctx) => {
  try {
    let body: PostBody;
    try {
      body = (await request.json()) as PostBody;
    } catch {
      return problemValidation('request body is not valid json');
    }

    const { version, fileName, contentType, releaseNotes, setAsLatest } = body;

    if (typeof version !== 'string' || !VERSION_REGEX.test(version)) {
      return NextResponse.json(
        { error: 'Invalid version format. Must be X.Y.Z (e.g. "2.2.1")' },
        { status: 400 },
      );
    }

    if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.exe')) {
      return NextResponse.json(
        { error: 'fileName is required and must end with .exe' },
        { status: 400 },
      );
    }

    const db = getAdminDb();
    const storage = getAdminStorage();
    const bucket = storage.bucket();
    const storagePath = `agent-installers/versions/${version}/Owlette-Installer-v${version}.exe`;
    const file = bucket.file(storagePath);

    // Generate signed upload URL (v4)
    const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_MINUTES * 60 * 1000);
    const [uploadUrl] = await file.getSignedUrl({
      action: 'write',
      version: 'v4',
      expires: expiresAt,
      contentType: typeof contentType === 'string' ? contentType : 'application/octet-stream',
    });

    // Store pending upload record
    const uploadId = crypto.randomUUID();
    await db.collection('installer_uploads').doc(uploadId).set({
      version,
      fileName,
      storagePath,
      userId: ctx.actor.userId,
      releaseNotes: typeof releaseNotes === 'string' ? releaseNotes : null,
      setAsLatest: setAsLatest !== false, // default true
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAt),
    });

    logger.info(`Installer upload initiated for v${version} by ${ctx.actor.userId}`, {
      context: 'admin/installer',
    });

    return NextResponse.json({
      success: true,
      uploadUrl,
      uploadId,
      storagePath,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error: unknown) {
    return apiError(error, 'admin/installer/upload POST');
  }
});

interface PutBody {
  uploadId?: unknown;
  checksum_sha256?: unknown;
}

/**
 * PUT /api/admin/installer/upload
 *
 * Step 2 of two-step upload: Finalize after client completes the upload to Storage.
 * Verifies the file exists, reads metadata, and delegates the metadata
 * write to the `uploadInstaller` action core.
 *
 * Request body:
 *   uploadId: string
 *   checksum_sha256?: string (client-computed, optional)
 */
export const PUT = authorizedPlatformHandler({
  capability: 'INSTALLER_MANAGE',
})(async (request: NextRequest, ctx) => {
  try {
    let body: PutBody;
    try {
      body = (await request.json()) as PutBody;
    } catch {
      return problemValidation('request body is not valid json');
    }
    const { uploadId, checksum_sha256 } = body;

    if (typeof uploadId !== 'string' || uploadId.length === 0) {
      return NextResponse.json(
        { error: 'Missing required field: uploadId' },
        { status: 400 },
      );
    }

    const db = getAdminDb();

    // Retrieve pending upload record
    const uploadDoc = await db.collection('installer_uploads').doc(uploadId).get();
    if (!uploadDoc.exists) {
      return NextResponse.json(
        { error: 'Upload record not found' },
        { status: 404 },
      );
    }

    const uploadData = uploadDoc.data()!;

    if (uploadData.status !== 'pending') {
      return NextResponse.json(
        { error: `Upload already ${uploadData.status}` },
        { status: 409 },
      );
    }

    const expiresAtMs = uploadData.expiresAt?.toMillis?.() ?? uploadData.expiresAt;
    if (Date.now() > expiresAtMs) {
      await db.collection('installer_uploads').doc(uploadId).update({ status: 'expired' });
      return NextResponse.json(
        { error: 'Upload has expired. Please request a new upload URL.' },
        { status: 410 },
      );
    }

    // Verify file exists in Storage
    const storage = getAdminStorage();
    const bucket = storage.bucket();
    const file = bucket.file(uploadData.storagePath);

    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json(
        { error: 'File not found in storage. Upload may not have completed.' },
        { status: 404 },
      );
    }

    // Get file metadata
    const [metadata] = await file.getMetadata();
    const fileSize = parseInt(metadata.size as string, 10) || 0;

    // Compute SHA-256 checksum server-side if client didn't provide one
    let finalChecksum: string;
    if (typeof checksum_sha256 === 'string' && checksum_sha256.length > 0) {
      finalChecksum = checksum_sha256;
    } else {
      const [fileBuffer] = await file.download();
      const hash = createHash('sha256').update(fileBuffer).digest('hex');
      finalChecksum = hash;
      logger.info(`Computed server-side checksum for v${uploadData.version}`, {
        context: 'admin/installer',
      });
    }

    // Generate long-lived signed download URL for agents
    const downloadExpiry = new Date('2030-01-01');
    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: downloadExpiry,
    });

    const version: string = uploadData.version;

    // Delegate metadata write to the action core. Preserves existing
    // 2-write semantics: version doc + optional /latest pointer.
    await uploadInstaller(
      { actor: ctx.actor },
      {
        version,
        download_url: downloadUrl,
        checksum_sha256: finalChecksum,
        file_size: fileSize,
        release_notes: uploadData.releaseNotes ?? null,
        uploaded_by: uploadData.userId ?? ctx.actor.userId,
        setAsLatest: uploadData.setAsLatest === true,
      },
    );

    // Mark upload as completed
    await db.collection('installer_uploads').doc(uploadId).update({
      status: 'completed',
      completedAt: Date.now(),
      file_size: fileSize,
    });

    logger.info(`Installer v${version} finalized (${(fileSize / 1024 / 1024).toFixed(1)} MB)`, {
      context: 'admin/installer',
    });

    return NextResponse.json({
      success: true,
      version,
      download_url: downloadUrl,
      checksum_sha256: finalChecksum,
      file_size: fileSize,
    });
  } catch (error: unknown) {
    return apiError(error, 'admin/installer/upload PUT');
  }
});
