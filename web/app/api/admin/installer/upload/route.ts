import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken } from '@/lib/apiAuth.server';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const SIGNED_URL_EXPIRY_MINUTES = 15;

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
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const body = await request.json();
      const { version, fileName, contentType, releaseNotes, setAsLatest } = body;

      if (!version || !VERSION_REGEX.test(version)) {
        return NextResponse.json(
          { error: 'Invalid version format. Must be X.Y.Z (e.g. "2.2.1")' },
          { status: 400 }
        );
      }

      if (!fileName || !fileName.toLowerCase().endsWith('.exe')) {
        return NextResponse.json(
          { error: 'fileName is required and must end with .exe' },
          { status: 400 }
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
        contentType: contentType || 'application/octet-stream',
      });

      // Store pending upload record
      const uploadId = crypto.randomUUID();
      await db.collection('installer_uploads').doc(uploadId).set({
        version,
        fileName,
        storagePath,
        userId,
        releaseNotes: releaseNotes || null,
        setAsLatest: setAsLatest !== false, // default true
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: expiresAt.getTime(),
      });

      logger.info(`Installer upload initiated for v${version} by ${userId}`, {
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
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/installer/upload POST:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'upload', identifier: 'ip' }
);

/**
 * PUT /api/admin/installer/upload
 *
 * Step 2 of two-step upload: Finalize after client completes the upload to Storage.
 * Verifies the file exists, reads metadata, and updates installer_metadata.
 *
 * Request body:
 *   uploadId: string
 *   checksum_sha256?: string (client-computed, optional)
 */
export const PUT = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdminOrIdToken(request);
      const body = await request.json();
      const { uploadId, checksum_sha256 } = body;

      if (!uploadId) {
        return NextResponse.json(
          { error: 'Missing required field: uploadId' },
          { status: 400 }
        );
      }

      const db = getAdminDb();

      // Retrieve pending upload record
      const uploadDoc = await db.collection('installer_uploads').doc(uploadId).get();
      if (!uploadDoc.exists) {
        return NextResponse.json(
          { error: 'Upload record not found' },
          { status: 404 }
        );
      }

      const uploadData = uploadDoc.data()!;

      if (uploadData.status !== 'pending') {
        return NextResponse.json(
          { error: `Upload already ${uploadData.status}` },
          { status: 409 }
        );
      }

      if (Date.now() > uploadData.expiresAt) {
        await db.collection('installer_uploads').doc(uploadId).update({ status: 'expired' });
        return NextResponse.json(
          { error: 'Upload has expired. Please request a new upload URL.' },
          { status: 410 }
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
          { status: 404 }
        );
      }

      // Get file metadata
      const [metadata] = await file.getMetadata();
      const fileSize = parseInt(metadata.size as string, 10) || 0;

      // Generate long-lived signed download URL for agents
      const downloadExpiry = new Date('2030-01-01');
      const [downloadUrl] = await file.getSignedUrl({
        action: 'read',
        expires: downloadExpiry,
      });

      const version = uploadData.version;
      const now = Date.now();

      // Write version metadata
      const versionData = {
        version,
        download_url: downloadUrl,
        checksum_sha256: checksum_sha256 || null,
        release_notes: uploadData.releaseNotes || null,
        file_size: fileSize,
        uploaded_at: now,
        uploaded_by: uploadData.userId,
      };

      await db.collection('installer_metadata').doc('data')
        .collection('versions').doc(version).set(versionData);

      // Update latest if requested
      if (uploadData.setAsLatest) {
        await db.collection('installer_metadata').doc('latest').set({
          ...versionData,
          release_date: new Date(now).toISOString(),
        });
      }

      // Mark upload as completed
      await db.collection('installer_uploads').doc(uploadId).update({
        status: 'completed',
        completedAt: now,
        file_size: fileSize,
      });

      logger.info(`Installer v${version} finalized (${(fileSize / 1024 / 1024).toFixed(1)} MB)`, {
        context: 'admin/installer',
      });

      return NextResponse.json({
        success: true,
        version,
        download_url: downloadUrl,
        checksum_sha256: checksum_sha256 || null,
        file_size: fileSize,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/installer/upload PUT:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'upload', identifier: 'ip' }
);
