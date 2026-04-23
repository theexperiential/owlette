/**
 * GET  /api/chunks/download-urls?siteId=...&hash=...&hash=...
 * POST /api/chunks/download-urls   { siteId: string, hashes: string[] }
 *
 * output: { urls: { [hash]: string }, expiresAt: string }
 *
 * roost wave 2a.5. issues short-lived signed GET URLs for the agent to
 * download chunks from R2. GET form is convenience for small batches
 * (watch for URL length cap ~2 KB); POST for large batches.
 *
 * - per-tenant siteId scope enforced via auth claims + assertUserHasSiteAccess
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { GET_URL_TTL_SECONDS, presignGetChunk } from '@/lib/r2Client.server';
import {
  parseJsonBody,
  validateHashList,
  validateSiteIdBody,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../_shared';

async function mintDownloadUrls(
  siteId: string,
  hashes: readonly string[],
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
  return NextResponse.json({ urls, expiresAt });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    const params = request.nextUrl.searchParams.getAll('hash');
    const validated = validateHashList(params, 'hash');
    if (!validated.ok) return validated.response;

    return await mintDownloadUrls(site.siteId, validated.hashes);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/download-urls (GET)');
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; hashes?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    const validated = validateHashList(body.hashes, 'hashes');
    if (!validated.ok) return validated.response;

    return await mintDownloadUrls(site.siteId, validated.hashes);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/download-urls (POST)');
  }
}
