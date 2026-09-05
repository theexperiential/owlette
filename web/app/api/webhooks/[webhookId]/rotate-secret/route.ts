/**
 * POST /api/webhooks/{webhookId}/rotate-secret?siteId=...
 * out: { id, siteId, signingSecret, previousSecretValidUntil, rotatedAt }. Scope site:<id>:write.
 *
 * Mints a fresh `whsec_*` and keeps the old one valid for 24h. The dispatcher MUST switch to
 * the new secret immediately — the grace window exists so receiver-side
 * `verifySignature(sig, body, OLD_SECRET)` keeps passing until they roll their env var, NOT
 * so the server keeps signing with the old secret. The new secret is returned ONCE (as with
 * create); the old one is never echoed back.
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
import { readWebhookSecrets, webhookSecretRef as secretRef } from '@/lib/webhookSecrets.server';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

import {
  auditActorIdentifier,
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
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

    // Site-admin action: rotation both mints a secret the caller gets to read and
    // breaks every receiver still on the old one after the grace window.
    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

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

    // The current secret lives in the server-only sibling; the webhook document
    // carries only rotation METADATA. Fall back to the legacy in-document field
    // so a subscription that predates the migration can still rotate.
    const stored = await readWebhookSecrets(site.siteId, webhookId);
    const currentSecret =
      stored.signingSecret ??
      (typeof existing.signingSecret === 'string' ? existing.signingSecret : null);

    const newSecret = generateSigningSecret();
    const rotatedAtMs = Date.now();
    const previousSecretValidUntilMs = rotatedAtMs + GRACE_PERIOD_MS;

    // Both writes in one batch: a failure between them would leave the
    // subscription signing with a secret the caller was never handed, or the
    // metadata pointing at a rotation that did not happen.
    const batch = db.batch();
    batch.set(secretRef(db, site.siteId, webhookId), {
      signingSecret: newSecret,
      previousSigningSecret: currentSecret,
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.update(ref, {
      // Strip any legacy in-document secrets left by a pre-migration write, so a
      // rotation also heals the leak for that subscription.
      signingSecret: FieldValue.delete(),
      previousSigningSecret: FieldValue.delete(),
      secret: FieldValue.delete(),
      previousSecretValidUntil: previousSecretValidUntilMs,
      secretRotatedAt: FieldValue.serverTimestamp(),
      secretRotatedBy: auth.userId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

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
