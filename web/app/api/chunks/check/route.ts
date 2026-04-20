/**
 * POST /api/chunks/check
 *
 * input:  { siteId: string, hashes: string[] }   (sha-256 hex, ≤ MAX_HASHES_PER_REQUEST)
 * output: { missing: string[] }                  (subset of input not yet present in r2)
 *
 * roost wave 2a.1. used by the browser uploader and external CLI to
 * skip chunks that already exist in cloud storage (CAS dedup).
 *
 * STUB: backing r2 query not yet wired. returns 503 with a clear marker.
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

    // TODO(wave 2a.1): query r2 for existing chunks under
    //   project-content/{siteId}/{hash[0:2]}/{hash}
    //   return only those not present.
    return notImplementedYet(
      '/api/chunks/check',
      'wave 2a.1',
      'wire to r2 head-object batch lookup; per-tenant prefix already site-scoped above',
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/check');
  }
}
