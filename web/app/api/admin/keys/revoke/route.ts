import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

/**
 * DELETE /api/admin/keys/revoke
 *
 * Revoke (delete) an API key.
 *
 * Request body:
 *   keyId: string — The key ID to revoke
 *
 * Response:
 *   { success: true }
 */
export const DELETE = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
    deprecated: true,
    routeName: 'DELETE /api/admin/keys/revoke',
  })(async (request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const body = await request.json();
      const { keyId } = body;

      if (!keyId) {
        return NextResponse.json({ error: 'Missing required field: keyId' }, { status: 400 });
      }

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
      // Remove top-level lookup entry
      if (keyHash) {
        batch.delete(db.collection('api_keys').doc(keyHash));
      }
      await batch.commit();

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      return apiError(error, 'admin/keys/revoke');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
