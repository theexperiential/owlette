/**
 * Version-addressing resolver for roost `{versionRef}` path params +
 * CLI `--to` / `--against` flags.
 *
 * Accepted `ref` forms (all map to the same `{ versionId, versionNumber }`):
 *
 *   - alias:    `current` / `previous` / `first`
 *   - stable id: a bare 64-char sha-256 hex string, or legacy `vrs_<hex>`
 *   - number:    `3` / `#3` / `v3` / `V3` (the per-roost versionNumber)
 *
 * The resolver is side-effect free — mutating routes (rollback, deploy,
 * PATCH) call this first to translate user input into a real version
 * doc, then run their work against the resolved id.
 *
 * Errors use `ResolveVersionError` subclasses so callers can cleanly map
 * to a problem+json response at the route boundary. The server is the
 * single source of truth for ref grammar — SDKs/CLIs must forward the
 * user's raw input verbatim.
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
 * `ResolveVersionError` (VersionNotFoundError / VersionRefMalformedError)
 * on any failure — the caller is expected to catch and translate.
 */
export async function resolveVersion(
  params: ResolveVersionParams,
): Promise<ResolvedVersion> {
  const { roostId, siteId } = params;

  // Trim whitespace that callers sometimes include from shell pastes
  // (`\n`, trailing spaces). An empty string after trimming is a
  // malformed ref, not a not-found — fail fast with 400.
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

  // ── alias forms ──────────────────────────────────────────────────
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

  // Stable content-addressed id forms. New publishes currently return a
  // bare sha-256 hex string; accept the old vrs_ form as a compatibility
  // alias so clients from the Roost-only API plan still resolve correctly.
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

  // ── number forms: `3`, `#3`, `v3`, `V3` ──────────────────────────
  // Strip the optional one-char prefix so the remainder is a pure
  // positive integer. We re-validate via String(n) === stripped to
  // reject inputs like `3abc` or `3.0` that `parseInt` would silently
  // coerce.
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
