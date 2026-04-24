/**
 * GET    /api/webhooks/{webhookId}?siteId=...
 *   output: { id, url, events, description?, createdAt, updatedAt, paused,
 *             lastDeliveryAt, lastDeliveryStatus, failureCount }
 *
 * PATCH  /api/webhooks/{webhookId}?siteId=...
 *   body:   { url?, events?, paused? }    — all fields optional
 *   output: serialized subscription (no signingSecret)
 *   - idempotency-key supported
 *   - events[] re-validated against `ROOST_WEBHOOK_EVENTS`
 *   - url re-run through SSRF guard (resolves DNS, blocks private ips)
 *
 * DELETE /api/webhooks/{webhookId}?siteId=...
 *   output: { id, siteId, softDeleted: true, tombstoneExpiresAt }
 *   - soft delete: stamps `deletedAt` + `tombstoneExpiresAt = now + 30d`.
 *     dispatcher filters on `deletedAt` when picking subscriptions to
 *     fire, so delivery stops on the next tick.
 *   - delivery history rows are **not** deleted (stored outside this doc,
 *     queryable via the wave 6.6 endpoints for the full 30-day audit
 *     window).
 *
 * Scope: site:<id>:read for GET, site:<id>:write for PATCH + DELETE.
 *
 * signingSecret is NEVER returned — only the create + rotate-secret
 * responses surface it.
 *
 * roost public api wave 6.2 (GET) + 6.3 (PATCH) + 6.4 (DELETE).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import { validateEvents } from '@/lib/webhookEvents';
import { validateWebhookUrl } from '@/lib/webhookUrl';

import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../../_shared';
import { serializeSubscription } from '../route';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function GET(
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

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const data = snap.data();

    if (!snap.exists || !data || data.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    return applyAuthDeprecations(
      NextResponse.json(serializeSubscription(webhookId, data)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:GET');
  }
}

/* ------------------------------------------------------------------------- */
/*  PATCH — update                                                           */
/* ------------------------------------------------------------------------- */

interface PatchBody {
  url?: unknown;
  events?: unknown;
  paused?: unknown;
}

export async function PATCH(
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

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    const body = (parsed.body ?? {}) as PatchBody;
    const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};

    if (body.url !== undefined) {
      const urlValidation = await validateWebhookUrl(body.url);
      if (!urlValidation.ok) {
        if (
          urlValidation.reason === 'private_ip' ||
          urlValidation.reason === 'bad_scheme' ||
          urlValidation.reason === 'bad_port'
        ) {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'webhook url rejected',
            status: 400,
            detail: urlValidation.detail ?? urlValidation.reason,
            instance: `/api/webhooks/${webhookId}`,
            code: urlValidation.reason,
            errors: { 'body.url': [urlValidation.detail ?? urlValidation.reason] },
          });
        }
        return problemValidation(urlValidation.detail ?? 'invalid url', {
          'body.url': [urlValidation.detail ?? urlValidation.reason],
        });
      }
      updates.url = urlValidation.url;
      updates.hostname = urlValidation.hostname;
    }

    if (body.events !== undefined) {
      const eventsValidation = validateEvents(body.events);
      if (!eventsValidation.ok) {
        const detail = eventsValidation.unknown.length
          ? `unknown event(s): ${eventsValidation.unknown.join(', ')}`
          : 'events must be a non-empty array';
        return problemValidation(detail, {
          'body.events': eventsValidation.unknown.length
            ? [`unknown: ${eventsValidation.unknown.join(', ')}`]
            : ['must be a non-empty array of known event names'],
        });
      }
      updates.events = eventsValidation.events;
    }

    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') {
        return problemValidation('paused must be a boolean when provided', {
          'body.paused': ['must be a boolean'],
        });
      }
      updates.paused = body.paused;
    }

    if (Object.keys(updates).length === 0) {
      return problemValidation('no updatable fields provided', {
        body: ['must include at least one of: url, events, paused'],
      });
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

    updates.updatedAt = FieldValue.serverTimestamp();
    await ref.update(updates);

    const refreshed = await ref.get();
    const refreshedData = refreshed.data() ?? existing;

    const response = applyAuthDeprecations(
      NextResponse.json(serializeSubscription(webhookId, { ...existing, ...refreshedData })),
      auth.scopeCheck,
    );

    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:PATCH');
  }
}

/* ------------------------------------------------------------------------- */
/*  DELETE — soft delete                                                     */
/* ------------------------------------------------------------------------- */

export async function DELETE(
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

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const existing = snap.data();

    if (!snap.exists || !existing) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    // Already soft-deleted: treat as idempotent success, re-return the
    // original tombstone timestamp so the client sees the same answer.
    if (existing.deletedAt) {
      const already =
        typeof existing.tombstoneExpiresAt === 'number'
          ? existing.tombstoneExpiresAt
          : Date.now() + TOMBSTONE_TTL_MS;
      return applyAuthDeprecations(
        NextResponse.json({
          id: webhookId,
          siteId: site.siteId,
          softDeleted: true,
          tombstoneExpiresAt: new Date(already).toISOString(),
        }),
        auth.scopeCheck,
      );
    }

    const tombstoneExpiresAt = Date.now() + TOMBSTONE_TTL_MS;
    await ref.update({
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.userId,
      tombstoneExpiresAt,
      paused: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return applyAuthDeprecations(
      NextResponse.json({
        id: webhookId,
        siteId: site.siteId,
        softDeleted: true,
        tombstoneExpiresAt: new Date(tombstoneExpiresAt).toISOString(),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:DELETE');
  }
}
