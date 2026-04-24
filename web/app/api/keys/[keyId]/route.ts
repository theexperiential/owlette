import { NextRequest, NextResponse } from 'next/server';
import {
  ApiAuthError,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';

interface RouteParams {
  params: Promise<{ keyId: string }>;
}

/**
 * DELETE /api/keys/{keyId}
 *
 * Revoke the authenticated user's own API key. Deletes both the user
 * subcollection doc and the top-level `api_keys/{keyHash}` lookup so auth
 * resolution fails immediately.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireSessionOrIdToken(request);
    const { keyId } = await params;

    if (!keyId || typeof keyId !== 'string') {
      return problemValidation('keyId is required');
    }

    const db = getAdminDb();
    const keyRef = db
      .collection('users')
      .doc(userId)
      .collection('api_keys')
      .doc(keyId);
    const keySnap = await keyRef.get();

    if (!keySnap.exists) {
      return problemNotFound('api key not found');
    }

    const keyHash = keySnap.data()?.keyHash;
    const batch = db.batch();
    batch.delete(keyRef);
    if (keyHash && typeof keyHash === 'string') {
      batch.delete(db.collection('api_keys').doc(keyHash));
    }
    await batch.commit();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      if (error.code === 'token_expired') {
        const expiredAt =
          typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
        return problemTokenExpired(expiredAt);
      }
      if (error.status === 401) return problemUnauthorized(error.message);
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: error.status,
        detail: error.message,
      });
    }
    return problemFromError(error, 'api/keys/[keyId]:DELETE');
  }
}
