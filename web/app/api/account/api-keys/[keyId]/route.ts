import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { problemNotFound, problemValidation } from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import type { ApiKeyRecord } from '@/lib/apiKeyTypes';

type RouteParams = {
  keyId: string;
} & Record<string, string | undefined>;

function auditActor(userId: string, keyId?: string): string {
  return keyId ? `apiKey:${keyId}` : `user:${userId}`;
}

/**
 * DELETE /api/account/api-keys/{keyId}
 *
 * Revoke an API key owned by the authenticated superadmin user.
 *
 * The second copy of the revoke path — it must stay equivalent in effect to
 * `DELETE /api/keys/{keyId}`, where the reasoning for every line below is written
 * out: soft delete, merge-set on the lookup so a missing doc cannot fail the
 * batch, numeric `Date.now()`, and an idempotent second revoke.
 */
export const DELETE = withRateLimit(
  authorizedPlatformHandler<RouteParams>({
    capability: 'GLOBAL_SETTINGS_WRITE',
  })(async (_request: NextRequest, ctx, routeContext) => {
    try {
      const { keyId } = await routeContext!.params;

      if (!keyId) {
        return problemValidation('Missing required field: keyId', {
          keyId: ['required'],
        });
      }

      const userId = ctx.actor.userId;
      const db = getAdminDb();
      const keyRef = db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .doc(keyId);

      const keyDoc = await keyRef.get();
      if (!keyDoc.exists) {
        return problemNotFound('API key not found');
      }

      const existing = keyDoc.data() as Partial<ApiKeyRecord> | undefined;

      if (existing?.revokedAt) {
        return NextResponse.json({ success: true });
      }

      const keyHash = existing?.keyHash;
      const revokedAt = Date.now();
      const batch = db.batch();
      batch.update(keyRef, { revokedAt });
      if (keyHash && typeof keyHash === 'string') {
        batch.set(db.collection('api_keys').doc(keyHash), { revokedAt }, { merge: true });
      }
      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: auditActor(userId, ctx.auth.keyContext?.keyId),
        targetId: keyId,
        attributes: {
          verb: 'revoke',
          endpoint: _request.nextUrl.pathname,
          method: _request.method,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys:revoke');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);
