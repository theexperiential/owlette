/**
 * GET    /api/roosts/{roostId}?siteId=...
 *        → detail: roost metadata + currentManifest + previousManifest summaries.
 *
 * PATCH  /api/roosts/{roostId}
 *        input:  { siteId, name?, targets?, extractPath? }
 *        → rename / re-target. pointer fields cannot be changed here.
 *
 * DELETE /api/roosts/{roostId}?siteId=...
 *        → soft-delete. stamps `deletedAt` and `tombstoneExpiresAt = now + 30d`.
 *
 * roost public api wave 3.1.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  parseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 200;
const MAX_TARGETS = 500;
const MAX_EXTRACT_PATH_LENGTH = 500;

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
        instance: `/api/roosts/${roostId}`,
      });
    }

    const data = roostSnap.data() ?? {};
    const currentManifestId = data.currentManifestId ?? null;
    const previousManifestId = data.previousManifestId ?? null;

    const [currentSnap, previousSnap] = await Promise.all([
      currentManifestId
        ? roostRef.collection('manifests').doc(currentManifestId).get()
        : Promise.resolve(null),
      previousManifestId
        ? roostRef.collection('manifests').doc(previousManifestId).get()
        : Promise.resolve(null),
    ]);

    return applyAuthDeprecations(
      NextResponse.json({
        roostId,
        siteId: site.siteId,
        name: typeof data.name === 'string' ? data.name : roostId,
        targets: Array.isArray(data.targets) ? data.targets : [],
        extractPath: typeof data.extractPath === 'string' ? data.extractPath : null,
        schemaVersion: data.schemaVersion ?? 2,
        currentManifestId,
        previousManifestId,
        manifestUrl: data.manifestUrl ?? null,
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
        createdBy: data.createdBy ?? null,
        deletedAt: timestampToIso(data.deletedAt),
        tombstoneExpiresAt: timestampToIso(data.tombstoneExpiresAt),
        currentManifest: summariseManifestSnap(currentSnap),
        previousManifest: summariseManifestSnap(previousSnap),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]:GET');
  }
}

interface PatchBody {
  siteId?: unknown;
  name?: unknown;
  targets?: unknown;
  extractPath?: unknown;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as PatchBody;

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'write');
    if (!auth.ok) return auth.response;

    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return problemValidation('name must be a non-empty string when provided', {
          'body.name': ['must be a non-empty string'],
        });
      }
      updates.name = body.name.trim().slice(0, MAX_NAME_LENGTH);
    }

    if (body.targets !== undefined) {
      if (
        !Array.isArray(body.targets) ||
        body.targets.some((t) => typeof t !== 'string' || t.length === 0)
      ) {
        return problemValidation('targets must be an array of machineId strings', {
          'body.targets': ['must be string[]'],
        });
      }
      updates.targets = [...new Set(body.targets as string[])].slice(0, MAX_TARGETS);
    }

    if (body.extractPath !== undefined) {
      if (typeof body.extractPath !== 'string') {
        return problemValidation('extractPath must be a string when provided', {
          'body.extractPath': ['must be a string'],
        });
      }
      const trimmed = body.extractPath.trim().slice(0, MAX_EXTRACT_PATH_LENGTH);
      updates.extractPath = trimmed.length > 0 ? trimmed : FieldValue.delete();
    }

    if (Object.keys(updates).length === 0) {
      return problemValidation(
        'at least one of name, targets, or extractPath is required',
      );
    }

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const existing = await roostRef.get();
    if (!existing.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}`,
      });
    }
    if (existing.data()?.deletedAt) {
      return problem({
        type: ProblemType.Conflict,
        title: 'roost deleted',
        status: 409,
        detail: `roost ${roostId} is soft-deleted; undelete before patching`,
        instance: `/api/roosts/${roostId}`,
      });
    }

    updates.updatedAt = FieldValue.serverTimestamp();
    await roostRef.update(updates);

    return applyAuthDeprecations(
      NextResponse.json({ roostId, siteId: site.siteId, updated: Object.keys(updates) }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]:PATCH');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('siteId query param required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'write');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const existing = await roostRef.get();
    if (!existing.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}`,
      });
    }

    const tombstoneExpiresAt = Date.now() + TOMBSTONE_TTL_MS;
    await roostRef.update({
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.userId,
      tombstoneExpiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return applyAuthDeprecations(
      NextResponse.json({
        roostId,
        siteId: site.siteId,
        softDeleted: true,
        tombstoneExpiresAt: new Date(tombstoneExpiresAt).toISOString(),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]:DELETE');
  }
}

function summariseManifestSnap(
  snap: FirebaseFirestore.DocumentSnapshot | null,
): {
  manifestId: string;
  manifestUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentManifestId: string | null;
} | null {
  if (!snap || !snap.exists) return null;
  const data = snap.data() ?? {};
  return {
    manifestId: snap.id,
    manifestUrl: data.manifestUrl ?? null,
    createdAt: timestampToIso(data.createdAt),
    createdBy: data.createdBy ?? null,
    totalSize: typeof data.totalSize === 'number' ? data.totalSize : 0,
    totalFiles: typeof data.totalFiles === 'number' ? data.totalFiles : 0,
    parentManifestId: data.parentManifestId ?? null,
  };
}
