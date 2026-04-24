/**
 * GET  /api/chunks/download-urls?siteId=...&hash=...&hash=...
 * POST /api/chunks/download-urls   { siteId: string, hashes: string[] }
 *
 * output: { urls: { [hash]: string }, expiresAt: string }
 *
 * roost wave 2a.5, scope-check wired in wave 2.4. Agent-token callers
 * bypass the scope gate (internal traffic); operator/API-key callers go
 * through the full site-access + scope check.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { GET_URL_TTL_SECONDS, presignGetChunk } from '@/lib/r2Client.server';
import type { ScopeCheckResult } from '@/lib/apiAuth.server';
import {
  applyAuthDeprecations,
  parseJsonBody,
  requireAgentOrSiteAuthAndScope,
  validateHashList,
  validateSiteIdBody,
} from '../../_shared';

async function mintDownloadUrls(
  siteId: string,
  hashes: readonly string[],
  scopeCheck: ScopeCheckResult,
): Promise<NextResponse> {
  const entries = await Promise.all(
    hashes.map(async (hash) => {
      const url = await presignGetChunk(siteId, hash);
      return [hash, url] as const;
    }),
  );
  const urls: Record<string, string> = {};
  for (const [hash, url] of entries) urls[hash] = url;
  const expiresAt = new Date(Date.now() + GET_URL_TTL_SECONDS * 1000).toISOString();
  return applyAuthDeprecations(NextResponse.json({ urls, expiresAt }), scopeCheck);
}

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

    const auth = await requireAgentOrSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const params = request.nextUrl.searchParams.getAll('hash');
    const validated = validateHashList(params, 'hash');
    if (!validated.ok) return validated.response;

    return await mintDownloadUrls(site.siteId, validated.hashes, auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/download-urls (GET)');
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; hashes?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireAgentOrSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const validated = validateHashList(body.hashes, 'hashes');
    if (!validated.ok) return validated.response;

    return await mintDownloadUrls(site.siteId, validated.hashes, auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/download-urls (POST)');
  }
}
