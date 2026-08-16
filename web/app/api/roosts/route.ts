/**
 * GET  /api/roosts?siteId=...&limit=20&cursor=...
 *      → list roosts for a site, cursor-paginated, soft-deleted filtered.
 *
 * POST /api/roosts
 *      input:  { siteId, name, targets[]?, roostId?, extractPath? }
 *      output: { roostId, siteId, name, targets, createdAt }
 *      → create a roost shell. No version is published; currentVersionId
 *        stays null until the first POST /api/roosts/{id}/versions.
 *
 * roost public api wave 3.1.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso, timestampToMs } from '@/lib/firestoreTime.server';
import { emitMutation } from '@/lib/auditLogClient';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  parseJsonBody,
  requireDistributionManageCapability,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../_shared';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_TARGETS = 500;
const MAX_NAME_LENGTH = 200;
const MAX_EXTRACT_PATH_LENGTH = 500;
const ROOST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

/* --------------------------------------------------------------------- */
/*  GET — list roosts                                                    */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  try {
    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIST_LIMIT,
      maxPageSize: MAX_LIST_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;
    const includeDeleted =
      request.nextUrl.searchParams.get('includeDeleted') === 'true';

    const db = getAdminDb();
    const roostsCol = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = roostsCol.orderBy('createdAt', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await roostsCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const data = doc.data();
        const deletedAt = timestampToMs(data.deletedAt);
        return includeDeleted || deletedAt === null;
      },
    });

    const roosts = page.docs
      .map((d) => {
        const data = d.data();
        return {
          roostId: d.id,
          siteId: site.siteId,
          name: typeof data.name === 'string' ? data.name : d.id,
          targets: Array.isArray(data.targets) ? data.targets : [],
          extractPath: typeof data.extractPath === 'string' ? data.extractPath : null,
          currentVersionId: data.currentVersionId ?? null,
          previousVersionId: data.previousVersionId ?? null,
          versionCounter:
            typeof data.versionCounter === 'number' ? data.versionCounter : 0,
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
          deletedAt: timestampToIso(data.deletedAt),
          tombstoneExpiresAt: timestampToIso(data.tombstoneExpiresAt),
        };
      })

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ roosts }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — create roost                                                  */
/* --------------------------------------------------------------------- */

interface CreateRoostBody {
  siteId?: unknown;
  name?: unknown;
  targets?: unknown;
  extractPath?: unknown;
  roostId?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as CreateRoostBody;

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireDistributionManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
        detail: 'roost `name` is required and cannot be empty or whitespace-only',
        code: 'roost_name_required',
        errors: { 'body.name': ['required non-empty string'] },
      });
    }
    const name = body.name.trim().slice(0, MAX_NAME_LENGTH);

    let targets: string[] = [];
    if (body.targets !== undefined) {
      if (
        !Array.isArray(body.targets) ||
        body.targets.some((t) => typeof t !== 'string' || t.length === 0)
      ) {
        return problemValidation('targets must be an array of machineId strings', {
          'body.targets': ['must be string[]'],
        });
      }
      targets = [...new Set(body.targets as string[])].slice(0, MAX_TARGETS);
    }

    let extractPath: string | undefined;
    if (body.extractPath !== undefined) {
      if (typeof body.extractPath !== 'string') {
        return problemValidation('extractPath must be a string when provided', {
          'body.extractPath': ['must be a string'],
        });
      }
      extractPath = body.extractPath.trim().slice(0, MAX_EXTRACT_PATH_LENGTH) || undefined;
    }

    let roostId: string;
    if (body.roostId !== undefined) {
      if (typeof body.roostId !== 'string' || !ROOST_ID_RE.test(body.roostId)) {
        return problemValidation(
          'roostId must be 8-64 chars: letters, digits, underscore, hyphen',
          { 'body.roostId': ['invalid format'] },
        );
      }
      roostId = body.roostId;
    } else {
      roostId = generateRoostId();
    }

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const existing = await roostRef.get();
    const wasDeleted = existing.exists && Boolean(existing.data()?.deletedAt);
    if (existing.exists) {
      const data = existing.data() ?? {};
      if (!data.deletedAt) {
        return problem({
          type: ProblemType.Conflict,
          title: 'roost already exists',
          status: 409,
          detail: `roost ${roostId} already exists on site ${site.siteId}`,
          instance: `/api/roosts/${roostId}`,
        });
      }
      // Undeleting a tombstoned roost: clear the deletion markers and
      // overwrite the metadata with the fresh payload.
    }

    await roostRef.set(
      {
        schemaVersion: 2,
        name,
        targets,
        ...(extractPath !== undefined ? { extractPath } : {}),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: auth.userId,
        deletedAt: null,
        tombstoneExpiresAt: null,
      },
      { merge: true },
    );

    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: roostId,
      attributes: {
        verb: wasDeleted ? 'undelete' : 'create',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        targetCount: targets.length,
        hasExtractPath: extractPath !== undefined,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json(
        {
          roostId,
          siteId: site.siteId,
          name,
          targets,
          ...(extractPath !== undefined ? { extractPath } : {}),
        },
        { status: 201 },
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts:POST');
  }
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

function generateRoostId(): string {
  // 18 hex chars = 72 bits of entropy. prefix `rst_` for readability;
  // together 22 chars, fits in 8-64 bound of RESOURCE_ID_RE.
  return `rst_${crypto.randomBytes(9).toString('hex')}`;
}

