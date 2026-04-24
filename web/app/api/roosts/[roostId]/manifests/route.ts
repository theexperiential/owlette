/**
 * GET  /api/roosts/{roostId}/manifests?siteId=...&limit=20&cursor=...
 *      → list manifest versions (rollback ui) — wave 2a.4
 *
 * POST /api/roosts/{roostId}/manifests
 *      input:  { siteId, manifest, expectedCurrentManifestId? }
 *      output: { manifestId, currentManifestId, previousManifestId }
 *      → finalize a new manifest version with **firestore transaction**
 *        for compare-and-swap on currentManifestId. Writes manifest body
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
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  bucketFor,
  currentEnv,
  hasChunk,
  manifestKey,
  putManifestBody,
} from '@/lib/r2Client.server';
import {
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

/* --------------------------------------------------------------------- */
/*  GET — list manifest history                                          */
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

    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIST_LIMIT);
    const limit = Math.min(
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIST_LIMIT),
      MAX_LIST_LIMIT,
    );
    const cursor = request.nextUrl.searchParams.get('cursor');

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
        instance: `/api/roosts/${roostId}/manifests`,
      });
    }

    let query = roostRef
      .collection('manifests')
      .orderBy('createdAt', 'desc')
      .limit(limit + 1);
    if (cursor) {
      const cursorSnap = await roostRef
        .collection('manifests')
        .doc(cursor)
        .get();
      if (cursorSnap.exists) {
        query = query.startAfter(cursorSnap);
      }
    }
    const snap = await query.get();
    const docs = snap.docs.slice(0, limit);
    const nextCursor = snap.docs.length > limit ? snap.docs[limit].id : null;

    const manifests = docs.map((d) => {
      const data = d.data();
      return {
        manifestId: d.id,
        manifestUrl: data.manifestUrl ?? null,
        createdAt: timestampToIso(data.createdAt),
        createdBy: data.createdBy ?? null,
        totalSize: data.totalSize ?? 0,
        totalFiles: data.totalFiles ?? 0,
        parentManifestId: data.parentManifestId ?? null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json({ manifests, nextCursor }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifests (GET)');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — finalize a new manifest                                       */
/* --------------------------------------------------------------------- */

interface ManifestShape {
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
      manifest?: unknown;
      expectedCurrentManifestId?: unknown;
      name?: unknown;
      targets?: unknown;
      extractPath?: unknown;
    };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'write');
    if (!auth.ok) return auth.response;

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

    const manifest = body.manifest;
    const manifestError = validateManifestShape(manifest);
    if (manifestError) return manifestError;

    const m = manifest as ManifestShape;

    // wave 3.6 follow-up: the client-facing display name + per-deploy
    // target set travel alongside the manifest. Without these the
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
        instance: `/api/roosts/${roostId}/manifests`,
        missingChunks: missing.slice(0, 20),
      });
    }

    // Derive a stable manifestId from the canonical JSON body.
    const canonicalBody = canonicalJson(m);
    const manifestId = await sha256Hex(canonicalBody);

    // Write the manifest body to R2. Done BEFORE the firestore transaction
    // so a transaction-abort doesn't leave an orphan manifest-pointer
    // referencing bytes that don't exist. R2 put is idempotent on the
    // content-addressed key (manifestId).
    await putManifestBody(site.siteId, roostId, manifestId, m);
    const manifestUrl =
      `https://${bucketFor(currentEnv(), 'manifests')}.${process.env.R2_S3_ENDPOINT?.replace(/^https?:\/\//, '')}/` +
      manifestKey(site.siteId, roostId, manifestId);

    // Firestore transaction: compare-and-swap on currentManifestId.
    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const totalSize = m.files.reduce((n, f) => n + f.size, 0);
    const expectedHead =
      typeof body.expectedCurrentManifestId === 'string'
        ? body.expectedCurrentManifestId
        : undefined;

    const result = await db.runTransaction(async (tx) => {
      const roostSnap = await tx.get(roostRef);
      const existing = roostSnap.exists ? roostSnap.data() ?? {} : {};
      const currentId = (existing.currentManifestId as string | undefined) ?? null;

      // optimistic concurrency: if the client passed an expected head
      // and the current head doesn't match, 412. Prevents two operators
      // racing to publish over each other.
      if (expectedHead !== undefined && currentId !== expectedHead) {
        return { conflict: true as const, currentId };
      }

      const manifestDocRef = roostRef.collection('manifests').doc(manifestId);
      tx.set(manifestDocRef, {
        manifestId,
        manifestUrl,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.userId,
        totalSize,
        totalFiles: m.files.length,
        parentManifestId: currentId,
      });

      // Always overwrite name/targets/extractPath when the client provides
      // them (each deploy is an explicit re-statement of intent). If the
      // client omits them, retain existing values — this lets a rollback
      // or manifest-only republish keep the prior config.
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

      tx.set(
        roostRef,
        {
          schemaVersion: 2,
          currentManifestId: manifestId,
          previousManifestId: currentId,
          manifestUrl,
          // Denormalised summary so the /roosts list can show "N files · X MB"
          // without needing to load each roost's manifest subdoc on render.
          // Matches what we write to the manifests subcollection above.
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
        manifestId,
        currentManifestId: manifestId,
        previousManifestId: currentId,
      };
    });

    if (result.conflict) {
      return problem({
        type: ProblemType.PreconditionFailed,
        title: 'head changed',
        status: 412,
        detail:
          `expectedCurrentManifestId did not match the current head ` +
          `(${result.currentId ?? 'null'}). re-read + retry.`,
        instance: `/api/roosts/${roostId}/manifests`,
      });
    }

    const response = applyAuthDeprecations(
      NextResponse.json(
        {
          manifestId: result.manifestId,
          currentManifestId: result.currentManifestId,
          previousManifestId: result.previousManifestId,
        },
        { status: 201 },
      ),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifests (POST)');
  }
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

function validateManifestShape(
  manifest: unknown,
): ReturnType<typeof problemValidation> | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return problemValidation('field `manifest` is required (oci manifest object)', {
      'body.manifest': ['must be a manifest object'],
    });
  }
  const m = manifest as Partial<ManifestShape>;
  if (m.schemaVersion !== 2) {
    return problemValidation('manifest.schemaVersion must be 2', {
      'body.manifest.schemaVersion': ['expected 2'],
    });
  }
  if (m.mediaType !== 'application/vnd.owlette.manifest.v1+json') {
    return problemValidation(
      'manifest.mediaType must be application/vnd.owlette.manifest.v1+json',
      { 'body.manifest.mediaType': ['expected vnd.owlette.manifest.v1+json'] },
    );
  }
  if (!m.config || typeof m.config !== 'object' || Array.isArray(m.config)) {
    return problemValidation('manifest.config must be an object', {
      'body.manifest.config': ['required object'],
    });
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    return problemValidation('manifest.files must be a non-empty array', {
      'body.manifest.files': ['required non-empty array'],
    });
  }
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i];
    if (!f || typeof f !== 'object') {
      return problemValidation(`manifest.files[${i}] must be an object`, {
        [`body.manifest.files[${i}]`]: ['required object'],
      });
    }
    if (typeof f.path !== 'string' || f.path.length === 0) {
      return problemValidation(`manifest.files[${i}].path is required`, {
        [`body.manifest.files[${i}].path`]: ['required string'],
      });
    }
    if (typeof f.size !== 'number' || f.size < 0) {
      return problemValidation(`manifest.files[${i}].size must be non-negative number`, {
        [`body.manifest.files[${i}].size`]: ['required non-negative number'],
      });
    }
    if (!Array.isArray(f.chunks)) {
      return problemValidation(`manifest.files[${i}].chunks must be an array`, {
        [`body.manifest.files[${i}].chunks`]: ['required array'],
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
          `manifest.files[${i}].chunks[${j}] must have hash (64-char lowercase hex) + positive size`,
          { [`body.manifest.files[${i}].chunks[${j}]`]: ['invalid chunk entry'] },
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
