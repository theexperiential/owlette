/**
 * Resolves roost `{versionRef}` path params and CLI `--to`/`--against` flags to
 * `{ versionId, versionNumber }`. Accepted forms: alias (`current`/`previous`/
 * `first`), stable id (bare 64-char sha-256 hex, or legacy `vrs_<hex>`), or
 * number (`3`/`#3`/`v3`/`V3`, the per-roost versionNumber).
 *
 * Side-effect free: mutating routes resolve first, then work against the id.
 * Errors are `ResolveVersionError` subclasses so routes can map to problem+json.
 * The server owns the ref grammar — SDKs/CLIs forward raw user input verbatim.
 */
import { getAdminDb } from '@/lib/firebase-admin';

export interface ResolvedVersion {
  versionId: string;
  versionNumber: number;
  doc: FirebaseFirestore.DocumentSnapshot;
}

export interface ResolveVersionParams {
  roostId: string;
  siteId: string;
  ref: string;
}

/** Base class — callers can `instanceof` narrow to the concrete subclass. */
export class ResolveVersionError extends Error {
  constructor(
    message: string,
    /** short stable code for the API error envelope. */
    public readonly code: string,
    /** recommended HTTP status when mapping to a problem+json response. */
    public readonly status: 400 | 404,
  ) {
    super(message);
    this.name = 'ResolveVersionError';
  }
}

export class VersionNotFoundError extends ResolveVersionError {
  constructor(detail: string) {
    super(detail, 'version_not_found', 404);
    this.name = 'VersionNotFoundError';
  }
}

export class VersionRefMalformedError extends ResolveVersionError {
  constructor(detail: string) {
    super(detail, 'version_ref_malformed', 400);
    this.name = 'VersionRefMalformedError';
  }
}

/**
 * Resolve a versionRef to a concrete `versions/{versionId}` doc. Throws
 * `VersionNotFoundError` / `VersionRefMalformedError` for the caller to translate.
 */
export async function resolveVersion(
  params: ResolveVersionParams,
): Promise<ResolvedVersion> {
  const { roostId, siteId } = params;

  // Shell pastes carry `\n`/trailing spaces. Empty after trimming is malformed
  // (400), not not-found.
  const ref = params.ref?.trim() ?? '';
  if (ref.length === 0) {
    throw new VersionRefMalformedError('versionRef must not be empty');
  }

  const db = getAdminDb();
  const roostRef = db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId);

  // alias forms
  if (ref === 'current' || ref === 'previous' || ref === 'first') {
    const roostSnap = await roostRef.get();
    if (!roostSnap.exists) {
      throw new VersionNotFoundError(`roost ${roostId} not found on site ${siteId}`);
    }
    const data = roostSnap.data() ?? {};

    if (ref === 'current') {
      const id = typeof data.currentVersionId === 'string' ? data.currentVersionId : null;
      if (!id) {
        throw new VersionNotFoundError(
          `roost ${roostId} has no current version (no publishes yet)`,
        );
      }
      return lookupById(roostRef, id);
    }
    if (ref === 'previous') {
      const id = typeof data.previousVersionId === 'string' ? data.previousVersionId : null;
      if (!id) {
        throw new VersionNotFoundError(
          `roost ${roostId} has no previous version`,
        );
      }
      return lookupById(roostRef, id);
    }
    // 'first' — the v1 publish, via the monotonic versionNumber field.
    return lookupByNumber(roostRef, 1);
  }

  // New publishes return bare sha-256 hex; the legacy `vrs_` form stays accepted
  // so older clients still resolve.
  if (/^[0-9a-f]{64}$/.test(ref)) {
    return lookupById(roostRef, ref);
  }
  if (ref.startsWith('vrs_')) {
    if (/^vrs_[0-9a-f]{64}$/.test(ref)) {
      const bareId = ref.slice(4);
      try {
        return await lookupById(roostRef, bareId);
      } catch (err) {
        if (!(err instanceof VersionNotFoundError)) throw err;
      }
    }
    return lookupById(roostRef, ref);
  }

  // number forms: `3`, `#3`, `v3`, `V3`
  // Strip the one-char prefix, then re-validate with String(n) === stripped to
  // reject `3abc` / `3.0`, which parseInt would silently coerce.
  const stripped = ref.replace(/^[#vV]/, '');
  const n = parseInt(stripped, 10);
  if (
    Number.isInteger(n) &&
    n > 0 &&
    String(n) === stripped
  ) {
    return lookupByNumber(roostRef, n);
  }

  throw new VersionRefMalformedError(
    `versionRef '${ref}' is malformed — accepts: a positive integer ('3'), ` +
      `'#3' / 'v3', a 64-char sha-256 version id, legacy 'vrs_*' id, ` +
      `or alias 'current'/'previous'/'first'.`,
  );
}

async function lookupById(
  roostRef: FirebaseFirestore.DocumentReference,
  id: string,
): Promise<ResolvedVersion> {
  const snap = await roostRef.collection('versions').doc(id).get();
  if (!snap.exists) {
    throw new VersionNotFoundError(`version ${id} not found on roost ${roostRef.id}`);
  }
  const data = snap.data() ?? {};
  const number = typeof data.versionNumber === 'number' ? data.versionNumber : 0;
  return { versionId: snap.id, versionNumber: number, doc: snap };
}

async function lookupByNumber(
  roostRef: FirebaseFirestore.DocumentReference,
  n: number,
): Promise<ResolvedVersion> {
  const snap = await roostRef
    .collection('versions')
    .where('versionNumber', '==', n)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new VersionNotFoundError(
      `no version with versionNumber=${n} on roost ${roostRef.id}`,
    );
  }
  const doc = snap.docs[0];
  const data = doc.data() ?? {};
  const number = typeof data.versionNumber === 'number' ? data.versionNumber : n;
  return { versionId: doc.id, versionNumber: number, doc };
}
