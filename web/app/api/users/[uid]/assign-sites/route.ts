/**
 * POST /api/users/{uid}/assign-sites
 *
 * Add one or more siteIds to `users/{uid}.sites[]` via `arrayUnion`
 * (idempotent at the field level — duplicates are de-duped). Each site
 * id in the request is validated against `sites/{id}` existence first;
 * if any are unknown, the entire request is rejected with 400
 * `unknown_site` and no sites are added.
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
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../../_shared';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SITES_PER_REQUEST = 100;

interface RouteParams {
  params: Promise<{ uid: string }>;
}

interface AssignBody {
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
        const body = parsed.body as AssignBody;
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

        // Verify the user exists + isn't soft-deleted before mutating.
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return problemNotFound(`user ${uid} not found`);
        }
        const userData = userSnap.data() ?? {};
        if (typeof userData.deletedAt === 'number') {
          return problemValidation(
            'cannot assign sites to a soft-deleted user',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }

        // Validate every site exists. Reject the whole batch if any are
        // unknown — partial assignments are confusing for callers.
        const unknownSites: string[] = [];
        await Promise.all(
          validatedSiteIds.map(async (siteId) => {
            const snap = await db.collection('sites').doc(siteId).get();
            if (!snap.exists) unknownSites.push(siteId);
          }),
        );
        if (unknownSites.length > 0) {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'unknown site(s)',
            status: 400,
            detail: 'one or more siteIds do not match an existing site',
            instance: `/api/users/${uid}/assign-sites`,
            code: 'unknown_site',
            unknownSites,
          });
        }

        await userRef.update({
          sites: FieldValue.arrayUnion(...validatedSiteIds),
        });

        emitMutation({
          kind: 'user_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: uid,
          attributes: {
            endpoint: `/api/users/${uid}/assign-sites`,
            method: 'POST',
            verb: 'sites_assigned',
            siteIds: validatedSiteIds,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            assignedSiteIds: validatedSiteIds,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/assign-sites:POST');
  }
}
