/**
 * GET  /api/chunks/download-urls?siteId=...&hash=...&hash=...
 * POST /api/chunks/download-urls   { siteId: string, hashes: string[] }
 *
 * output: { urls: { [hash]: { downloadUrl: string, expiresAt: string } } }
 *
 * roost wave 2a.5. issues short-lived (≤15min) signed GET urls for the
 * agent to download chunks from r2.
 *
 * GET form is convenience for small batches; POST for large batches
 * (avoid url length limits).
 *
 * - rate-limited (per-token + per-ip) — TODO: wrap in withRateLimit (plan wave 2.9)
 * - per-tenant siteId scope enforced via auth claims
 *
 * STUB: backing r2 signed-url issuance not yet wired. returns 503.
 */
import type { NextRequest } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  parseJsonBody,
  validateHashList,
  validateSiteIdBody,
  notImplementedYet,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../_shared';

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
    // delegate empty/length/format validation to the shared helper to
    // avoid duplicating its three-case error logic here.
    const validated = validateHashList(params, 'hash');
    if (!validated.ok) return validated.response;

    return notImplementedYet(
      '/api/chunks/download-urls',
      'wave 2a.5',
      'wire r2 signed-GET issuance; ttl ≤ 15min; enforce per-tenant prefix',
    );
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

    return notImplementedYet(
      '/api/chunks/download-urls',
      'wave 2a.5',
      'wire r2 signed-GET issuance; ttl ≤ 15min; enforce per-tenant prefix',
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/download-urls (POST)');
  }
}
