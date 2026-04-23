/**
 * POST /api/chunks/upload-urls
 *
 * input:  { siteId: string, hashes: string[] }
 * output: { urls: { [hash]: string }, expiresAt: string }
 *
 * roost wave 2a.2. issues short-lived signed PUT urls for the browser
 * or agent to upload chunks directly to R2. TTL fixed per PUT_URL_TTL_SECONDS.
 *
 * - per-tenant siteId scope enforced via auth claims + assertUserHasSiteAccess.
 *   Signed URLs are scoped to project-content/{siteId}/… paths only.
 * - Idempotency-Key header honored at the layer that actually spans requests
 *   (not implemented here — each call mints fresh URLs; cross-request caching
 *   is a future optimisation, low-value since URLs are cheap to mint).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { presignPutChunk, PUT_URL_TTL_SECONDS } from '@/lib/r2Client.server';
import {
  parseJsonBody,
  validateHashList,
  validateSiteIdBody,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../_shared';

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

    // Mint in parallel — each presign is a local HMAC compute, no network hop.
    const entries = await Promise.all(
      validated.hashes.map(async (hash) => {
        const url = await presignPutChunk(site.siteId, hash);
        return [hash, url] as const;
      }),
    );

    const urls: Record<string, string> = {};
    for (const [hash, url] of entries) urls[hash] = url;

    const expiresAt = new Date(Date.now() + PUT_URL_TTL_SECONDS * 1000).toISOString();
    return NextResponse.json({ urls, expiresAt });
  } catch (err) {
    return problemFromError(err, 'v2/chunks/upload-urls');
  }
}
