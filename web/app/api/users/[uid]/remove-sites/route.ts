/**
 * POST /api/users/{uid}/remove-sites
 *
 * Remove one or more siteIds from `users/{uid}.sites[]` via `arrayRemove`.
 * Best-effort cancels pending commands the user issued on those sites
 * (failure to cancel doesn't block the response — the membership removal
 * is the authoritative state change).
 *
 * Auth:
 *   - api key with `user=*:write` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Idempotency: required.
 *
 * api-sprint wave 3 track 3B (users-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../../_shared';
import { cancelUserCommandsOnSites } from '@/lib/userDeleteCascade.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SITES_PER_REQUEST = 100;

interface RouteParams {
  params: Promise<{ uid: string }>;
}

interface RemoveBody {
  siteIds?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { uid } = await params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'user', 'write');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as RemoveBody;
        const siteIds = body.siteIds;
        if (!Array.isArray(siteIds) || siteIds.length === 0) {
          return problemValidation(
            'siteIds is required and must be a non-empty array',
            { 'body.siteIds': ['must be a non-empty array of site ids'] },
          );
        }
        if (siteIds.length > MAX_SITES_PER_REQUEST) {
          return problemValidation(
            `siteIds contains ${siteIds.length} entries; max is ${MAX_SITES_PER_REQUEST}`,
            {
              'body.siteIds': [
                `maximum ${MAX_SITES_PER_REQUEST} site ids per request`,
              ],
            },
          );
        }
        const malformed = siteIds.filter(
          (s): s is string =>
            typeof s !== 'string' || !SITE_ID_REGEX.test(s as string),
        );
        if (malformed.length > 0) {
          return problemValidation(
            'siteIds contains malformed entries',
            {
              'body.siteIds': [
                'each entry must match site-id format (1-128 chars: letters, digits, underscore, hyphen)',
              ],
            },
          );
        }
        const validatedSiteIds = Array.from(new Set(siteIds as string[]));

        const db = getAdminDb();
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return problemNotFound(`user ${uid} not found`);
        }

        await userRef.update({
          sites: FieldValue.arrayRemove(...validatedSiteIds),
        });

        // Best-effort: cancel pending commands the user issued on the
        // removed sites. Errors here don't block the response — the
        // arrayRemove above is the authoritative state change.
        let cancelledCommandCount = 0;
        try {
          cancelledCommandCount = await cancelUserCommandsOnSites(
            uid,
            validatedSiteIds,
          );
        } catch (err) {
          console.warn(
            `[remove-sites] command cancel sweep failed: ${
              (err as Error).message
            }`,
          );
        }

        emitMutation({
          kind: 'user_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: uid,
          attributes: {
            endpoint: `/api/users/${uid}/remove-sites`,
            method: 'POST',
            verb: 'sites_removed',
            siteIds: validatedSiteIds,
            cancelledCommandCount,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            removedSiteIds: validatedSiteIds,
            cancelledCommandCount,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/remove-sites:POST');
  }
}
