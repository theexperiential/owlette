/**
 * POST /api/users/{uid}/promote
 *
 * Promote a user to `admin` or `superadmin`. Atomic via a Firestore
 * transaction so concurrent role mutations cannot interleave.
 *
 * Auth:
 *   - api key with `user=*:write` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Idempotency: required. Re-issuing the same Idempotency-Key with the same
 * body within 24h returns the cached response.
 *
 * api-sprint wave 3 track 3B (users-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
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

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const PROMOTE_ROLES = new Set(['admin', 'superadmin']);

interface RouteParams {
  params: Promise<{ uid: string }>;
}

interface PromoteBody {
  role?: unknown;
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
        const body = parsed.body as PromoteBody;
        const role = body.role;
        if (typeof role !== 'string' || !PROMOTE_ROLES.has(role)) {
          return problemValidation(
            'role is required and must be admin or superadmin',
            { 'body.role': ['must be one of: admin, superadmin'] },
          );
        }

        const db = getAdminDb();
        const userRef = db.collection('users').doc(uid);

        const result = await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          if (!snap.exists) {
            return { kind: 'not_found' as const };
          }
          const data = snap.data() ?? {};
          if (typeof data.deletedAt === 'number') {
            return { kind: 'deleted' as const };
          }
          const previousRole =
            typeof data.role === 'string' ? data.role : 'member';
          if (previousRole === role) {
            return {
              kind: 'noop' as const,
              previousRole,
              newRole: role,
            };
          }
          tx.update(userRef, { role });
          return {
            kind: 'updated' as const,
            previousRole,
            newRole: role,
          };
        });

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }
        if (result.kind === 'deleted') {
          return problemValidation(
            'cannot promote a soft-deleted user; restore the account first',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }

        if (result.kind === 'updated') {
          emitMutation({
            kind: 'user_mutated',
            siteId: '',
            actor: auth.auth.keyContext
              ? `apiKey:${auth.auth.keyContext.keyId}`
              : `user:${auth.userId}`,
            targetId: uid,
            attributes: {
              endpoint: `/api/users/${uid}/promote`,
              method: 'POST',
              verb: 'promoted',
              from: result.previousRole,
              to: result.newRole,
            },
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            role: result.newRole,
            previousRole: result.previousRole,
            changed: result.kind === 'updated',
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/promote:POST');
  }
}
