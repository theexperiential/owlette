import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { problemNotFound, problemValidation } from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

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

      const keyHash = keyDoc.data()?.keyHash;
      const batch = db.batch();
      batch.delete(keyRef);
      if (keyHash) {
        batch.delete(db.collection('api_keys').doc(keyHash));
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
