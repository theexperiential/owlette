/**
 * POST /api/webhooks/{webhookId}/rotate-secret?siteId=...
 *   output: { id, siteId, signingSecret, previousSecretValidUntil, rotatedAt }
 *
 *   - generates a fresh `whsec_*` secret
 *   - keeps the old secret alive for a 24h grace window so in-flight
 *     receivers can verify either signature while they roll their env
 *     var. the dispatcher (wave 6.9) MUST sign with the **new** secret
 *     immediately — the grace period is so verifier-side tooling that
 *     calls `verifySignature(sig, body, OLD_SECRET)` keeps returning ok
 *     until receivers update, not so the server keeps signing with the
 *     old one.
 *   - response returns the new secret ONCE (same contract as create);
 *     the old secret is never echoed back in any form.
 *
 * Scope: site:<id>:write.
 *
 * roost public api wave 6.5.
 */

import { randomBytes } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { emitMutation } from '@/lib/auditLogClient';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

import {
  auditActorIdentifier,
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../../../_shared';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SIGNING_SECRET_BYTES = 32;
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    const rawBody = await request.text().catch(() => '');
    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const existing = snap.data();

    if (!snap.exists || !existing || existing.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    const currentSecret =
      typeof existing.signingSecret === 'string' ? existing.signingSecret : null;

    const newSecret = generateSigningSecret();
    const rotatedAtMs = Date.now();
    const previousSecretValidUntilMs = rotatedAtMs + GRACE_PERIOD_MS;

    await ref.update({
      signingSecret: newSecret,
      previousSigningSecret: currentSecret,
      previousSecretValidUntil: previousSecretValidUntilMs,
      secretRotatedAt: FieldValue.serverTimestamp(),
      secretRotatedBy: auth.userId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    emitMutation({
      kind: 'webhook_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: webhookId,
      attributes: {
        verb: 'rotate_secret',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        previousSecretValidUntil: previousSecretValidUntilMs,
        gracePeriodHours: GRACE_PERIOD_MS / (60 * 60 * 1000),
      },
    });

    const response = applyAuthDeprecations(
      NextResponse.json({
        id: webhookId,
        siteId: site.siteId,
        signingSecret: newSecret,
        previousSecretValidUntil: new Date(previousSecretValidUntilMs).toISOString(),
        gracePeriodHours: GRACE_PERIOD_MS / (60 * 60 * 1000),
        rotatedAt: new Date(rotatedAtMs).toISOString(),
      }),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]/rotate-secret:POST');
  }
}

function generateSigningSecret(): string {
  return `whsec_${randomBytes(SIGNING_SECRET_BYTES).toString('hex')}`;
}
