import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

/**
 * GET /api/account/api-keys
 *
 * List all active API keys for the authenticated superadmin user.
 * Returns metadata only -- never the raw key or hash.
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
  })(async (_request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const db = getAdminDb();

      const keysSnap = await db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .orderBy('createdAt', 'desc')
        .get();

      const keys = keysSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          keyPrefix: data.keyPrefix,
          createdAt: data.createdAt,
          lastUsedAt: data.lastUsedAt,
        };
      });

      return NextResponse.json({ success: true, keys });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);

/**
 * POST /api/account/api-keys
 *
 * Generate a new API key for the authenticated superadmin user.
 * Returns the raw key once -- only the SHA-256 hash is stored.
 */
export const POST = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
  })(async (request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const body = await request.json().catch(() => ({}));
      const name = body.name || 'API Key';

      const rawKey = `owk_${crypto.randomBytes(32).toString('base64url')}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();

      const db = getAdminDb();
      const batch = db.batch();

      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        {
          name,
          keyHash,
          keyPrefix: rawKey.slice(0, 11),
          createdAt: FieldValue.serverTimestamp(),
          lastUsedAt: null,
        },
      );

      batch.set(
        db.collection('api_keys').doc(keyHash),
        { userId, keyId },
      );

      await batch.commit();

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
      });
    } catch (error: unknown) {
      return apiError(error, 'account/api-keys:create');
    }
  }),
  { strategy: 'api', identifier: 'ip' },
);
