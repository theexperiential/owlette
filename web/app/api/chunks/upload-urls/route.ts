/**
 * POST /api/chunks/upload-urls
 *
 * input:  { siteId: string, hashes: string[] }
 * output: { urls: { [hash]: string }, expiresAt: string }
 *
 * roost wave 2a.2, scope-check wired in wave 2.4.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { presignPutChunk, PUT_URL_TTL_SECONDS } from '@/lib/r2Client.server';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  applyAuthDeprecations,
  parseJsonBody,
  requireSiteAuthAndScope,
  validateHashList,
  validateSiteIdBody,
} from '../../_shared';

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; hashes?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

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
    return applyAuthDeprecations(NextResponse.json({ urls, expiresAt }), auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/upload-urls');
  }
}
