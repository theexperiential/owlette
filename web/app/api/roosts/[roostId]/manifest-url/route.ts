/**
 * POST /api/roosts/{roostId}/manifest-url
 *
 * input:  { siteId: string, manifestId: string }
 * output: { url: string, expiresAt: string }
 *
 * Mints a fresh short-lived signed GET URL for a manifest JSON body
 * stored in R2. Agents call this at sync time — signed URLs are 15 min
 * so a URL baked into the roost doc at publish time would already be
 * expired by the time a canary retry (or anything slower than ~15 min)
 * ran. Mirrors the `/api/chunks/download-urls` pattern.
 *
 * The roost doc's stored `manifestUrl` is an UNSIGNED object URL kept
 * as a hint for tooling. It is NOT fetchable directly from a private
 * R2 bucket — clients must call this endpoint to get a fetchable URL.
 *
 * Security:
 * - Auth required (bearer token, matches chunk endpoints).
 * - requireSiteScope ensures the caller can read the named site.
 * - We validate `manifestId` exists on the roost's manifests subcollection
 *   so callers can only mint URLs for manifests actually published to
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
import { presignGetManifest, GET_URL_TTL_SECONDS } from '@/lib/r2Client.server';
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
    const body = parsed.body as { siteId?: unknown; manifestId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireAgentOrSiteScope(request, site.siteId);
    if (!auth.ok) return auth.response;

    if (typeof body.manifestId !== 'string') {
      return problemValidation('manifestId must be a string', {
        'body.manifestId': ['must be a string'],
      });
    }
    const manifestIdError = validateResourceId(body.manifestId, 'manifestId');
    if (manifestIdError) return manifestIdError;

    // Confirm the manifest belongs to this roost on this site. Without
    // this check a compromised agent could mint GET URLs for any
    // manifestId (SHA-256 is unguessable but defence-in-depth is cheap).
    const db = getAdminDb();
    const manifestRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('manifests')
      .doc(body.manifestId);
    const snap = await manifestRef.get();
    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'manifest not found',
        status: 404,
        detail: `manifest ${body.manifestId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/manifest-url`,
      });
    }

    const url = await presignGetManifest(site.siteId, roostId, body.manifestId);
    const expiresAt = new Date(Date.now() + GET_URL_TTL_SECONDS * 1000).toISOString();
    return NextResponse.json({ url, expiresAt });
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifest-url');
  }
}
