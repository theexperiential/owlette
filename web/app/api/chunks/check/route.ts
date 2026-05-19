/**
 * POST /api/chunks/check
 *
 * input:  { siteId: string, hashes: string[] }   (sha-256 hex, ≤ MAX_HASHES_PER_REQUEST)
 * output: { missing: string[] }                  (subset of input not yet present in r2)
 *
 * roost wave 2a.1, scope-check wired in wave 2.4.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { missingChunks } from '@/lib/r2Client.server';
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

    const missing = await missingChunks(site.siteId, validated.hashes);
    return applyAuthDeprecations(NextResponse.json({ missing }), auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'v2/chunks/check');
  }
}
