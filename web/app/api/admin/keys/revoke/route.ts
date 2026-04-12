import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

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
  async (request: NextRequest) => {
    try {
      const userId = await requireAdmin(request);
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
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/keys/revoke');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
