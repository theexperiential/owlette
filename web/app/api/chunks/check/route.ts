/**
 * POST /api/chunks/check
 *
 * input:  { siteId: string, hashes: string[] }   (sha-256 hex, ≤ MAX_HASHES_PER_REQUEST)
 * output: { missing: string[] }                  (subset of input not yet present in r2)
 *
 * roost wave 2a.1. used by the browser uploader and external CLI to
 * skip chunks that already exist in cloud storage (CAS dedup).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { missingChunks } from '@/lib/r2Client.server';
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

    // Batch-HEAD each hash against R2 at project-content/{siteId}/{hash[:2]}/{hash};
    // return the subset that returned 404. Per-tenant scope is already
    // enforced by `site.siteId` from the validated body + requireSiteScope.
    const missing = await missingChunks(site.siteId, validated.hashes);
    return NextResponse.json({ missing });
  } catch (err) {
    return problemFromError(err, 'v2/chunks/check');
  }
}
