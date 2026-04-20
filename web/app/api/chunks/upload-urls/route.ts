/**
 * POST /api/chunks/upload-urls
 *
 * input:  { siteId: string, hashes: string[] }
 * output: { urls: { [hash]: { uploadUrl: string, expiresAt: string } } }
 *
 * roost wave 2a.2. issues short-lived (≤60min) signed PUT urls for the
 * browser/agent to upload chunks directly to r2.
 *
 * - rate-limited (per-token + per-ip) — TODO: wrap in withRateLimit (see plan wave 2.9)
 * - per-tenant siteId scope enforced via auth claims + assertUserHasSiteAccess
 *
 * STUB: backing r2 signed-url issuance not yet wired. returns 503.
 * implement when wave 0.5 (cloudflare r2) is provisioned.
 */
import type { NextRequest } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import {
  parseJsonBody,
  validateHashList,
  validateSiteIdBody,
  notImplementedYet,
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

    // TODO(wave 2a.2): issue r2 signed PUT urls scoped to per-tenant prefix
    //   project-content/{siteId}/{hash[0:2]}/{hash}
    //   ttl ≤ 60 min. response shape: { urls: {[hash]: {uploadUrl, expiresAt}} }
    //   honor Idempotency-Key header — reuse cached urls within ttl
    return notImplementedYet(
      '/api/chunks/upload-urls',
      'wave 2a.2',
      'wire r2 signed-PUT issuance; cache by Idempotency-Key; enforce per-tenant prefix',
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/upload-urls');
  }
}
