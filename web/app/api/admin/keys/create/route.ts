import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

/**
 * POST /api/admin/keys/create
 *
 * Generate a new API key for the authenticated admin user.
 * Returns the raw key ONCE — only the SHA-256 hash is stored.
 *
 * Request body:
 *   name?: string — Optional label for the key (default: "API Key")
 *
 * Response:
 *   { success: true, key: "owk_...", keyId: string, name: string }
 */
export const POST = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
    deprecated: true,
    routeName: 'POST /api/admin/keys/create',
  })(async (request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const body = await request.json().catch(() => ({}));
      const name = body.name || 'API Key';

      // Generate a random key with owk_ prefix
      const rawKey = `owk_${crypto.randomBytes(32).toString('base64url')}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();

      const db = getAdminDb();
      const batch = db.batch();

      // User's subcollection entry (for listing/management)
      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        {
          name,
          keyHash,
          keyPrefix: rawKey.slice(0, 11), // "owk_" + first 7 chars for display
          createdAt: FieldValue.serverTimestamp(),
          lastUsedAt: null,
        }
      );

      // Top-level lookup entry (for fast auth resolution — single doc read)
      batch.set(
        db.collection('api_keys').doc(keyHash),
        { userId, keyId }
      );

      await batch.commit();

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
      });
    } catch (error: unknown) {
      return apiError(error, 'admin/keys/create');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
