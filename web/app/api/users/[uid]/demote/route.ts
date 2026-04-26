/**
 * POST /api/users/{uid}/demote
 *
 * Demote a user to `member`. Atomic via a Firestore transaction.
 *
 * **Last-superadmin guard.** When demoting a `superadmin`, the transaction
 * counts active (non-deleted) superadmins; if demoting the target would
 * drop the count below 1, returns 409 `last_superadmin`. The check runs
 * inside the same transaction as the role write so two concurrent demotes
 * cannot both observe "2 superadmins" and both succeed.
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
const MIN_SUPERADMINS = 1;

interface RouteParams {
  params: Promise<{ uid: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { uid } = await params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    // Read the body once so idempotency body-hashing is consistent even
    // when callers send `{}` or no body.
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
        const db = getAdminDb();
        const userRef = db.collection('users').doc(uid);
        const usersCol = db.collection('users');

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

          if (previousRole === 'member') {
            return {
              kind: 'noop' as const,
              previousRole,
              newRole: 'member' as const,
            };
          }

          // Last-superadmin protection: count active superadmins inside
          // the transaction so a concurrent demote can't race past us.
          if (previousRole === 'superadmin') {
            const allSnap = await tx.get(usersCol);
            const activeSuperadmins = allSnap.docs.reduce((n, doc) => {
              const d = doc.data() ?? {};
              if (d.role !== 'superadmin') return n;
              if (typeof d.deletedAt === 'number') return n;
              return n + 1;
            }, 0);
            if (activeSuperadmins <= MIN_SUPERADMINS) {
              return {
                kind: 'last_superadmin' as const,
                activeSuperadmins,
              };
            }
          }

          tx.update(userRef, { role: 'member' });
          return {
            kind: 'updated' as const,
            previousRole,
            newRole: 'member' as const,
          };
        });

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }
        if (result.kind === 'deleted') {
          return problemValidation(
            'cannot demote a soft-deleted user; restore the account first',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }
        if (result.kind === 'last_superadmin') {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot demote last superadmin',
            status: 409,
            detail: `cannot demote: only ${result.activeSuperadmins} active superadmin(s) remain; floor is ${MIN_SUPERADMINS}`,
            instance: `/api/users/${uid}/demote`,
            code: 'last_superadmin',
            minSuperadmins: MIN_SUPERADMINS,
            currentActiveCount: result.activeSuperadmins,
          });
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
              endpoint: `/api/users/${uid}/demote`,
              method: 'POST',
              verb: 'demoted',
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
    return problemFromError(err, 'users/[uid]/demote:POST');
  }
}
