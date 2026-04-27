import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

type RouteParams = {
  keyId: string;
} & Record<string, string | undefined>;

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
        return NextResponse.json({ error: 'Missing required field: keyId' }, { status: 400 });
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
        return NextResponse.json({ error: 'API key not found' }, { status: 404 });
      }

      const keyHash = keyDoc.data()?.keyHash;
      const batch = db.batch();
      batch.delete(keyRef);
      if (keyHash) {
        batch.delete(db.collection('api_keys').doc(keyHash));
      }
      await batch.commit();

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys:revoke');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);
