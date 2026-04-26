/**
 * setLatestInstaller action core (security-boundary-migration wave 3.11).
 *
 * Mirrors `useInstallerManagement:setAsLatest`
 * (web/hooks/useInstallerManagement.ts:198-232) and the existing
 * `POST /api/installer/{version}/set-latest` route
 * (web/app/api/installer/[version]/set-latest/route.ts).
 *
 * Atomically promotes a non-deleted installer version to the
 * `installer_metadata/latest` pointer. Refuses if the source version doc
 * doesn't exist or has been soft-deleted.
 *
 * The existing API route already implements this exact flow with idempotency
 * + audit-log emission + scope checks. This action core lifts the
 * transactional core out so the `authorizedPlatformHandler` shim can call it
 * directly. The existing `requirePlatformAuthAndScope`-wrapped route stays
 * untouched as the public surface (preserving idempotency keys + RFC 7807
 * shape); the `/api/admin/installer/[version]/set-latest` mirror created in
 * this wave is the new admin-namespace entry point.
 *
 * firestore paths: platform-level (NOT site-scoped).
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import { InstallerValidationError, VERSION_REGEX } from './uploadInstaller.server';

export interface SetLatestInstallerContext {
  actor: UserActor;
  version: string;
}

export interface SetLatestInstallerResult {
  version: string;
  latest: Record<string, unknown>;
}

export class InstallerVersionNotFoundError extends Error {
  version: string;
  constructor(version: string) {
    super(`installer version not found: ${version}`);
    this.name = 'InstallerVersionNotFoundError';
    this.version = version;
  }
}

export class InstallerVersionDeletedError extends Error {
  version: string;
  constructor(version: string) {
    super(`installer version is soft-deleted: ${version}`);
    this.name = 'InstallerVersionDeletedError';
    this.version = version;
  }
}

export async function setLatestInstaller(
  ctx: SetLatestInstallerContext,
): Promise<SetLatestInstallerResult> {
  if (typeof ctx.version !== 'string' || !VERSION_REGEX.test(ctx.version)) {
    throw new InstallerValidationError(
      'version',
      'version must be a semver string like "2.2.1"',
    );
  }

  const db = getAdminDb();
  const versionRef = db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(ctx.version);
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
    const latestData: Record<string, unknown> = {
      version: data.version || ctx.version,
      download_url: data.download_url ?? null,
      checksum_sha256: data.checksum_sha256 ?? null,
      release_notes: data.release_notes ?? null,
      file_size: data.file_size ?? null,
      uploaded_at: data.uploaded_at ?? null,
      uploaded_by: data.uploaded_by ?? null,
      release_date: new Date(now).toISOString(),
      promoted_at: now,
      promoted_by: ctx.actor.userId,
    };
    tx.set(latestRef, latestData);
    return { kind: 'set' as const, latestData };
  });

  if (result.kind === 'not_found') {
    throw new InstallerVersionNotFoundError(ctx.version);
  }
  if (result.kind === 'deleted') {
    throw new InstallerVersionDeletedError(ctx.version);
  }
  return { version: ctx.version, latest: result.latestData };
}
