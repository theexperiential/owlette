/**
 * GET  /api/roosts/{roostId}/versions?siteId=...&limit=20&cursor=...
 *      → list published versions (rollback ui) — wave 2a.4
 *
 * POST /api/roosts/{roostId}/versions
 *      input:  { siteId, version, expectedCurrentVersionId? }
 *      output: { versionId, currentVersionId, previousVersionId }
 *      → finalize a new version with **firestore transaction**
 *        for compare-and-swap on currentVersionId. Writes version body
 *        to R2, audit-log entry, trips the fan-out cloud function (2b.3).
 *        wave 2a.3.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
  problem,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  nextPageTokenFromDocs,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  bucketFor,
  currentEnv,
  hasChunk,
  versionKey,
  putVersionBody,
} from '@/lib/r2Client.server';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

const CHUNK_VERIFY_CONCURRENCY = 32;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_DESCRIPTION_LENGTH = 500;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

/* --------------------------------------------------------------------- */
/*  GET — list version history                                           */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIST_LIMIT,
      maxPageSize: MAX_LIST_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);
    const roostSnap = await roostRef.get();
    if (!roostSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/versions`,
      });
    }

    let query = roostRef
      .collection('versions')
      .orderBy('createdAt', 'desc')
      .limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await roostRef
        .collection('versions')
        .doc(pageToken)
        .get();
      if (cursorSnap.exists) {
        query = query.startAfter(cursorSnap);
      }
    }
    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = nextPageTokenFromDocs(snap.docs, pageSize);

    const versions = docs.map((d) => {
      const data = d.data();
      return {
        versionId: d.id,
        versionNumber: typeof data.versionNumber === 'number' ? data.versionNumber : null,
        description: typeof data.description === 'string' ? data.description : null,
        versionUrl: data.versionUrl ?? null,
        createdAt: timestampToIso(data.createdAt),
        createdBy: data.createdBy ?? null,
        totalSize: data.totalSize ?? 0,
        totalFiles: data.totalFiles ?? 0,
        parentVersionId: data.parentVersionId ?? null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json(
        withPaginationFields(
          {
            versions,
            nextCursor: nextPageToken || null,
          },
          nextPageToken,
        ),
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/versions (GET)');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — finalize a new version                                        */
/* --------------------------------------------------------------------- */

interface VersionShape {
  schemaVersion: number;
  mediaType: string;
  config: Record<string, unknown>;
  files: Array<{
    path: string;
    size: number;
    chunks: Array<{ hash: string; size: number }>;
  }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      siteId?: unknown;
      version?: unknown;
      expectedCurrentVersionId?: unknown;
      name?: unknown;
      targets?: unknown;
      extractPath?: unknown;
      description?: unknown;
    };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'write');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'replay' || idem.mode === 'mismatch') {
      return idem.response;
    }

    const version = body.version;
    const versionError = validateVersionShape(version);
    if (versionError) return versionError;

    const m = version as VersionShape;

    // wave 3.6 follow-up: the client-facing display name + per-deploy
    // target set travel alongside the version. Without these the
    // roost doc ends up nameless with empty targets[], which
    // breaks both the UI listing and the fan-out cloud function.
    let deployName: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return problemValidation('name must be a non-empty string when provided', {
          'body.name': ['must be a non-empty string'],
        });
      }
      deployName = body.name.trim().slice(0, 200);
    }
    let deployTargets: string[] | undefined;
    if (body.targets !== undefined) {
      if (!Array.isArray(body.targets) || body.targets.some((t) => typeof t !== 'string' || !t)) {
        return problemValidation('targets must be an array of non-empty machineId strings', {
          'body.targets': ['must be string[]'],
        });
      }
      // Dedup + cap at 500 to prevent firestore doc bloat.
      deployTargets = [...new Set(body.targets as string[])].slice(0, 500);
    }
    let deployExtractPath: string | undefined;
    if (body.extractPath !== undefined) {
      if (typeof body.extractPath !== 'string') {
        return problemValidation('extractPath must be a string', {
          'body.extractPath': ['must be a string'],
        });
      }
      deployExtractPath = body.extractPath.trim().slice(0, 500) || undefined;
    }

    // Optional plaintext description — commit-message style "what changed?".
    // Stored as null (not empty string) when missing/whitespace-only so
    // downstream consumers can branch cleanly on presence. Reject > 500 chars
    // rather than silently truncating — operators who paste paragraphs get
    // an explicit 400 so they can re-enter a summary deliberately.
    let deployDescription: string | null = null;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') {
        return problemValidation('description must be a string when provided', {
          'body.description': ['must be a string'],
        });
      }
      if (body.description.length > MAX_DESCRIPTION_LENGTH) {
        return problemValidation(
          `description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
          { 'body.description': [`must be ≤ ${MAX_DESCRIPTION_LENGTH} chars`] },
        );
      }
      const trimmed = body.description.trim();
      deployDescription = trimmed.length > 0 ? trimmed : null;
    }

    const hasExpectedHead = Object.prototype.hasOwnProperty.call(
      body,
      'expectedCurrentVersionId',
    );
    let expectedHead: string | null | undefined;
    if (typeof body.expectedCurrentVersionId === 'string') {
      expectedHead = body.expectedCurrentVersionId;
    } else if (hasExpectedHead && body.expectedCurrentVersionId === null) {
      expectedHead = null;
    } else if (hasExpectedHead && body.expectedCurrentVersionId !== undefined) {
      return problemValidation(
        'expectedCurrentVersionId must be a string or null when provided',
        { 'body.expectedCurrentVersionId': ['must be a string or null'] },
      );
    }

    // Verify every referenced chunk exists in R2. Missing chunks = caller
    // didn't finish uploading; reject with a listing of missing hashes so
    // the client can retry the missing set via /chunks/upload-urls.
    const allHashes = new Set<string>();
    for (const f of m.files) for (const c of f.chunks) allHashes.add(c.hash);
    const missing = await verifyChunksPresent(site.siteId, [...allHashes]);
    if (missing.length > 0) {
      return problem({
        type: ProblemType.PreconditionFailed,
        title: 'chunks missing in storage',
        status: 412,
        detail:
          `${missing.length} referenced chunk(s) are not present in R2. ` +
          `upload them via /api/chunks/upload-urls before finalising.`,
        instance: `/api/roosts/${roostId}/versions`,
        missingChunks: missing.slice(0, 20),
      });
    }

    // Derive a stable versionId from the canonical JSON body.
    const canonicalBody = canonicalJson(m);
    const versionId = await sha256Hex(canonicalBody);
    const chunkReferrers = summariseChunkReferences(m);

    // Write the version body to R2. Done BEFORE the firestore transaction
    // so a transaction-abort doesn't leave an orphan version-pointer
    // referencing bytes that don't exist. R2 put is idempotent on the
    // content-addressed key (versionId).
    await putVersionBody(site.siteId, roostId, versionId, m);
    const versionUrl =
      `https://${bucketFor(currentEnv(), 'manifests')}.${process.env.R2_S3_ENDPOINT?.replace(/^https?:\/\//, '')}/` +
      versionKey(site.siteId, roostId, versionId);

    // Firestore transaction: compare-and-swap on currentVersionId +
    // monotonic versionNumber mint. The counter lives on the roost doc
    // itself; reading + updating both in the same tx is what guarantees
    // no two concurrent publishes end up with the same versionNumber.
    // Firestore's optimistic-concurrency layer retries the transaction on
    // conflict, so the second publisher sees the incremented counter.
    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);
    const versionDocRef = roostRef.collection('versions').doc(versionId);

    const totalSize = m.files.reduce((n, f) => n + f.size, 0);

    const result = await db.runTransaction(async (tx) => {
      const [roostSnap, versionSnap] = await Promise.all([
        tx.get(roostRef),
        tx.get(versionDocRef),
      ]);
      const existing = roostSnap.exists ? roostSnap.data() ?? {} : {};
      const currentId = (existing.currentVersionId as string | undefined) ?? null;

      // Content-addressed no-op: publishing bytes that are already the
      // current head must not advance versionCounter or overwrite the same
      // version doc with a new versionNumber.
      if (currentId === versionId) {
        const existingNumber =
          typeof existing.currentVersionNumber === 'number'
            ? existing.currentVersionNumber
            : typeof existing.versionCounter === 'number'
              ? existing.versionCounter
              : 0;
        const previousVersionId =
          typeof existing.previousVersionId === 'string'
            ? existing.previousVersionId
            : null;
        return {
          conflict: false as const,
          outcome: 'noop' as const,
          versionId,
          versionNumber: existingNumber,
          currentVersionId: versionId,
          previousVersionId,
        };
      }

      // optimistic concurrency: if the client passed an expected head
      // and the current head doesn't match, 412. Prevents two operators
      // racing to publish over each other. Runs inside the tx so the
      // check + write are atomic against the roost doc — a stale head
      // can't slip past a concurrent publisher.
      if (expectedHead !== undefined && currentId !== expectedHead) {
        return { conflict: true as const, currentId };
      }

      // Always overwrite name/targets/extractPath when the client provides
      // them (each deploy is an explicit re-statement of intent). If the
      // client omits them, retain existing values - this lets a rollback
      // or version-only republish keep the prior config.
      const nameField =
        deployName !== undefined
          ? { name: deployName }
          : existing.name !== undefined
            ? {}
            : { name: roostId };
      const targetsField =
        deployTargets !== undefined
          ? { targets: deployTargets }
          : existing.targets !== undefined
            ? {}
            : { targets: [] };
      const extractPathField =
        deployExtractPath !== undefined ? { extractPath: deployExtractPath } : {};

      // Content-addressed promote: the requested content already exists in
      // history but is not the current head. Move only the roost pointer and
      // denormalised current-version summary; keep the historical version doc
      // immutable and do not advance versionCounter.
      if (versionSnap.exists) {
        const existingVersion = versionSnap.data() ?? {};
        const existingVersionNumber =
          typeof existingVersion.versionNumber === 'number'
            ? existingVersion.versionNumber
            : 0;
        const existingDescription =
          typeof existingVersion.description === 'string'
            ? existingVersion.description
            : null;
        const existingVersionUrl =
          typeof existingVersion.versionUrl === 'string'
            ? existingVersion.versionUrl
            : versionUrl;
        const existingTotalFiles =
          typeof existingVersion.totalFiles === 'number'
            ? existingVersion.totalFiles
            : m.files.length;
        const existingTotalSize =
          typeof existingVersion.totalSize === 'number'
            ? existingVersion.totalSize
            : totalSize;

        tx.set(
          roostRef,
          {
            schemaVersion: 2,
            currentVersionId: versionId,
            currentVersionNumber: existingVersionNumber,
            currentVersionDescription: existingDescription,
            previousVersionId: currentId,
            versionUrl: existingVersionUrl,
            totalFiles: existingTotalFiles,
            totalSize: existingTotalSize,
            updatedAt: FieldValue.serverTimestamp(),
            ...nameField,
            ...targetsField,
            ...extractPathField,
            ...(roostSnap.exists
              ? {}
              : {
                  createdAt: FieldValue.serverTimestamp(),
                  createdBy: auth.userId,
                }),
          },
          { merge: true },
        );

        return {
          conflict: false as const,
          outcome: 'promote' as const,
          versionId,
          versionNumber: existingVersionNumber,
          currentVersionId: versionId,
          previousVersionId: currentId,
        };
      }

      // Monotonic 1-indexed version number per roost. starts at 0 (new
      // roost, no versions yet) so the first publish lands as v1. The
      // counter only advances inside a successful tx — if the tx retries
      // due to a contending publish, the retried read picks up the new
      // counter and we get v(N+1) cleanly, no ties.
      const currentCounter =
        typeof existing.versionCounter === 'number' ? existing.versionCounter : 0;
      const nextNumber = currentCounter + 1;

      tx.set(versionDocRef, {
        versionId,
        versionNumber: nextNumber,
        description: deployDescription,
        versionUrl,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.userId,
        totalSize,
        totalFiles: m.files.length,
        parentVersionId: currentId,
      });

      tx.set(
        roostRef,
        {
          schemaVersion: 2,
          versionCounter: nextNumber,
          currentVersionId: versionId,
          // Denormalised current-version summary so the /roost list can
          // render "v{N} · description" without fanning out to each
          // version subdoc on render.
          currentVersionNumber: nextNumber,
          currentVersionDescription: deployDescription,
          previousVersionId: currentId,
          versionUrl,
          // Denormalised summary so the /roost list can show "N files · X MB"
          // without needing to load each roost's version subdoc on render.
          // Matches what we write to the versions subcollection above.
          totalFiles: m.files.length,
          totalSize,
          updatedAt: FieldValue.serverTimestamp(),
          ...nameField,
          ...targetsField,
          ...extractPathField,
          ...(roostSnap.exists
            ? {}
            : {
                createdAt: FieldValue.serverTimestamp(),
                createdBy: auth.userId,
              }),
        },
        { merge: true },
      );

      return {
        conflict: false as const,
        outcome: 'create' as const,
        versionId,
        versionNumber: nextNumber,
        currentVersionId: versionId,
        previousVersionId: currentId,
      };
    });

    if (result.conflict) {
      return problem({
        type: ProblemType.PreconditionFailed,
        title: 'head changed',
        status: 412,
        detail:
          `expectedCurrentVersionId did not match the current head ` +
          `(${result.currentId ?? 'null'}). re-read + retry.`,
        instance: `/api/roosts/${roostId}/versions`,
        code: 'version_stale',
      });
    }

    if (result.outcome === 'create') {
      await writeVersionChunkReferrers(
        db,
        site.siteId,
        roostId,
        result.versionId,
        result.versionNumber,
        auth.userId,
        chunkReferrers,
      );
    }

    const response = applyAuthDeprecations(
      NextResponse.json(
        {
          versionId: result.versionId,
          versionNumber: result.versionNumber,
          currentVersionId: result.currentVersionId,
          previousVersionId: result.previousVersionId,
        },
        { status: result.outcome === 'create' ? 201 : 200 },
      ),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    if (result.outcome !== 'noop') {
      emitMutation({
        kind: 'roost_mutated',
        siteId: site.siteId,
        actor: auditActorIdentifier(auth.auth),
        targetId: result.versionId,
        attributes: {
          verb:
            result.outcome === 'promote'
              ? 'version_promote'
              : 'version_publish',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          roostId,
          versionNumber: result.versionNumber,
          previousVersionId: result.previousVersionId,
          totalFiles: m.files.length,
          totalSize,
          hasDescription: deployDescription !== null,
        },
      });
    }
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/versions (POST)');
  }
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

function validateVersionShape(
  version: unknown,
): ReturnType<typeof problemValidation> | null {
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    return problemValidation('field `version` is required (oci version object)', {
      'body.version': ['must be a version object'],
    });
  }
  const m = version as Partial<VersionShape>;
  if (m.schemaVersion !== 2) {
    return problemValidation('version.schemaVersion must be 2', {
      'body.version.schemaVersion': ['expected 2'],
    });
  }
  if (m.mediaType !== 'application/vnd.owlette.version.v1+json') {
    return problemValidation(
      'version.mediaType must be application/vnd.owlette.version.v1+json',
      { 'body.version.mediaType': ['expected vnd.owlette.version.v1+json'] },
    );
  }
  if (!m.config || typeof m.config !== 'object' || Array.isArray(m.config)) {
    return problemValidation('version.config must be an object', {
      'body.version.config': ['required object'],
    });
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    return problemValidation('version.files must be a non-empty array', {
      'body.version.files': ['required non-empty array'],
    });
  }
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i];
    if (!f || typeof f !== 'object') {
      return problemValidation(`version.files[${i}] must be an object`, {
        [`body.version.files[${i}]`]: ['required object'],
      });
    }
    if (typeof f.path !== 'string' || f.path.length === 0) {
      return problemValidation(`version.files[${i}].path is required`, {
        [`body.version.files[${i}].path`]: ['required string'],
      });
    }
    if (typeof f.size !== 'number' || f.size < 0) {
      return problemValidation(`version.files[${i}].size must be non-negative number`, {
        [`body.version.files[${i}].size`]: ['required non-negative number'],
      });
    }
    if (!Array.isArray(f.chunks)) {
      return problemValidation(`version.files[${i}].chunks must be an array`, {
        [`body.version.files[${i}].chunks`]: ['required array'],
      });
    }
    for (let j = 0; j < f.chunks.length; j++) {
      const c = f.chunks[j];
      if (
        !c ||
        typeof c.hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(c.hash) ||
        typeof c.size !== 'number' ||
        c.size <= 0
      ) {
        return problemValidation(
          `version.files[${i}].chunks[${j}] must have hash (64-char lowercase hex) + positive size`,
          { [`body.version.files[${i}].chunks[${j}]`]: ['invalid chunk entry'] },
        );
      }
    }
  }
  return null;
}

async function verifyChunksPresent(
  siteId: string,
  hashes: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < hashes.length) {
      const i = cursor++;
      const h = hashes[i];
      const present = await hasChunk(siteId, h);
      if (!present) missing.push(h);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CHUNK_VERIFY_CONCURRENCY, hashes.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return missing;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface ChunkReferenceSummary {
  digest: string;
  fileCount: number;
  totalBytes: number;
}

function summariseChunkReferences(version: VersionShape): ChunkReferenceSummary[] {
  const refs = new Map<string, { paths: Set<string>; totalBytes: number }>();
  for (const file of version.files) {
    for (const chunk of file.chunks) {
      const existing = refs.get(chunk.hash) ?? {
        paths: new Set<string>(),
        totalBytes: 0,
      };
      existing.paths.add(file.path);
      existing.totalBytes += chunk.size;
      refs.set(chunk.hash, existing);
    }
  }
  return [...refs.entries()].map(([digest, ref]) => ({
    digest,
    fileCount: ref.paths.size,
    totalBytes: ref.totalBytes,
  }));
}

async function writeVersionChunkReferrers(
  db: ReturnType<typeof getAdminDb>,
  siteId: string,
  roostId: string,
  versionId: string,
  versionNumber: number,
  createdBy: string,
  refs: readonly ChunkReferenceSummary[],
): Promise<void> {
  const batchLimit = 450;
  for (let i = 0; i < refs.length; i += batchLimit) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + batchLimit)) {
      const entryRef = db
        .collection('sites')
        .doc(siteId)
        .collection('chunk_referrers')
        .doc(ref.digest)
        .collection('entries')
        .doc(`version_${roostId}_${versionId}`);
      batch.set(
        entryRef,
        {
          digest: ref.digest,
          source: 'version',
          roostId,
          versionId,
          versionNumber,
          fileCount: ref.fileCount,
          pathCount: ref.fileCount,
          totalBytes: ref.totalBytes,
          createdAt: FieldValue.serverTimestamp(),
          createdBy,
          mountedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    await batch.commit();
  }
}
