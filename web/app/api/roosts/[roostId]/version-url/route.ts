/**
 * POST /api/roosts/{roostId}/version-url
 * in:  { siteId, versionId }   out: { url, expiresAt }
 *
 * Fresh 15-minute signed GET url for a version JSON body in R2, minted at sync time — a url
 * baked into the roost doc at publish would already be expired by the time a canary retry
 * ran. Mirrors /api/chunks/download-urls. The roost doc's `versionUrl` is UNSIGNED, a hint
 * for tooling only, and is not fetchable from the private bucket.
 *
 * Auth required, requireSiteScope on the named site, and `versionId` must exist on this
 * roost's versions subcollection so callers can't probe arbitrary R2 keys.
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
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  parseJsonBody,
  validateResourceId,
  validateSiteIdBody,
  requireAgentOrSiteScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
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

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    if (typeof body.versionId !== 'string') {
      return problemValidation('versionId must be a string', {
        'body.versionId': ['must be a string'],
      });
    }
    const versionIdError = validateResourceId(body.versionId, 'versionId');
    if (versionIdError) return versionIdError;

    // Without this, a compromised agent could mint GET urls for any versionId.
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
