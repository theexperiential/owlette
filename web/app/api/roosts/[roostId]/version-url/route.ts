/**
 * POST /api/roosts/{roostId}/version-url
 *
 * input:  { siteId: string, versionId: string }
 * output: { url: string, expiresAt: string }
 *
 * Mints a fresh short-lived signed GET URL for a version JSON body
 * stored in R2. Agents call this at sync time — signed URLs are 15 min
 * so a URL baked into the roost doc at publish time would already be
 * expired by the time a canary retry (or anything slower than ~15 min)
 * ran. Mirrors the `/api/chunks/download-urls` pattern.
 *
 * The roost doc's stored `versionUrl` is an UNSIGNED object URL kept
 * as a hint for tooling. It is NOT fetchable directly from a private
 * R2 bucket — clients must call this endpoint to get a fetchable URL.
 *
 * Security:
 * - Auth required (bearer token, matches chunk endpoints).
 * - requireSiteScope ensures the caller can read the named site.
 * - We validate `versionId` exists on the roost's versions subcollection
 *   so callers can only mint URLs for versions actually published to
 *   this roost (can't probe arbitrary R2 keys by guessing ids).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { presignGetVersion, GET_URL_TTL_SECONDS } from '@/lib/r2Client.server';
import {
  parseJsonBody,
  validateResourceId,
  validateSiteIdBody,
  requireAgentOrSiteScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; versionId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireAgentOrSiteScope(request, site.siteId);
    if (!auth.ok) return auth.response;

    if (typeof body.versionId !== 'string') {
      return problemValidation('versionId must be a string', {
        'body.versionId': ['must be a string'],
      });
    }
    const versionIdError = validateResourceId(body.versionId, 'versionId');
    if (versionIdError) return versionIdError;

    // Confirm the version belongs to this roost on this site. Without
    // this check a compromised agent could mint GET URLs for any
    // versionId (SHA-256 is unguessable but defence-in-depth is cheap).
    const db = getAdminDb();
    const versionRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('versions')
      .doc(body.versionId);
    const snap = await versionRef.get();
    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'version not found',
        status: 404,
        detail: `version ${body.versionId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/version-url`,
        code: 'version_not_found',
      });
    }

    const url = await presignGetVersion(site.siteId, roostId, body.versionId);
    const expiresAt = new Date(Date.now() + GET_URL_TTL_SECONDS * 1000).toISOString();
    return NextResponse.json({ url, expiresAt });
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/version-url');
  }
}
