/**
 * uploadInstaller action core (security-boundary-migration wave 3.11).
 *
 * Mirrors the metadata-write half of `useInstallerManagement:uploadVersion`
 * (web/hooks/useInstallerManagement.ts:137-191) and the existing
 * `PUT /api/admin/installer/upload` finalize step
 * (web/app/api/admin/installer/upload/route.ts:107-237).
 *
 * Two writes happen atomically per call:
 *
 *   1. `installer_metadata/data/versions/{version}` — the version doc.
 *   2. `installer_metadata/latest`                  — only if `setAsLatest`.
 *
 * The signed-URL request + binary upload + sha256 verify steps stay in the
 * route layer (they coordinate Firebase Storage + Firestore upload-state
 * tracking, not just a metadata write). This action core handles the final
 * metadata commit only — keeping the 3-step request URL → upload → finalize
 * flow exactly intact per the build-and-upload guide in `.claude/CLAUDE.md`.
 *
 * firestore paths: platform-level (NOT site-scoped). Wrapped at the route
 * layer with `authorizedPlatformHandler({ capability: 'INSTALLER_MANAGE' })`.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';

export interface UploadInstallerInput {
  version: string;
  download_url: string;
  checksum_sha256: string;
  file_size: number;
  release_notes?: string | null;
  uploaded_by?: string;
  setAsLatest?: boolean;
}

export interface UploadInstallerContext {
  actor: UserActor;
}

export interface UploadInstallerResult {
  version: string;
  download_url: string;
  checksum_sha256: string;
  file_size: number;
  set_as_latest: boolean;
}

export class InstallerValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InstallerValidationError';
    this.field = field;
  }
}

export const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

export async function uploadInstaller(
  ctx: UploadInstallerContext,
  input: UploadInstallerInput,
): Promise<UploadInstallerResult> {
  if (typeof input.version !== 'string' || !VERSION_REGEX.test(input.version)) {
    throw new InstallerValidationError(
      'version',
      'version must be a semver string like "2.2.1"',
    );
  }
  if (typeof input.download_url !== 'string' || input.download_url.length === 0) {
    throw new InstallerValidationError(
      'download_url',
      'download_url is required and must be a non-empty string',
    );
  }
  if (typeof input.checksum_sha256 !== 'string' || input.checksum_sha256.length === 0) {
    throw new InstallerValidationError(
      'checksum_sha256',
      'checksum_sha256 is required and must be a non-empty string',
    );
  }
  if (
    typeof input.file_size !== 'number' ||
    !Number.isFinite(input.file_size) ||
    input.file_size < 0
  ) {
    throw new InstallerValidationError(
      'file_size',
      'file_size must be a non-negative finite number',
    );
  }
  if (
    input.release_notes !== undefined &&
    input.release_notes !== null &&
    typeof input.release_notes !== 'string'
  ) {
    throw new InstallerValidationError(
      'release_notes',
      'release_notes must be a string, null, or omitted',
    );
  }
  if (input.uploaded_by !== undefined && typeof input.uploaded_by !== 'string') {
    throw new InstallerValidationError('uploaded_by', 'uploaded_by must be a string');
  }
  if (input.setAsLatest !== undefined && typeof input.setAsLatest !== 'boolean') {
    throw new InstallerValidationError('setAsLatest', 'setAsLatest must be a boolean');
  }

  const setAsLatest = input.setAsLatest !== false; // default true to match existing route
  const now = Date.now();
  const uploadedBy = input.uploaded_by ?? ctx.actor.userId;

  const versionData = {
    version: input.version,
    download_url: input.download_url,
    checksum_sha256: input.checksum_sha256,
    release_notes: input.release_notes ?? null,
    file_size: input.file_size,
    uploaded_at: now,
    release_date: Timestamp.fromMillis(now),
    uploaded_by: uploadedBy,
  };

  const db = getAdminDb();
  const versionRef = db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(input.version);

  await versionRef.set(versionData);

  if (setAsLatest) {
    const latestRef = db.collection('installer_metadata').doc('latest');
    await latestRef.set({
      ...versionData,
      // The legacy `/latest` doc stored release_date as an ISO string for
      // compatibility with agents that parse it as text. Preserve that.
      release_date: new Date(now).toISOString(),
    });
  }

  return {
    version: input.version,
    download_url: input.download_url,
    checksum_sha256: input.checksum_sha256,
    file_size: input.file_size,
    set_as_latest: setAsLatest,
  };
}
