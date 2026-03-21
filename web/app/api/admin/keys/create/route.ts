import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';

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
  async (request: NextRequest) => {
    try {
      const userId = await requireAdmin(request);
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
        db.collection('users').doc(userId).collection('apiKeys').doc(keyId),
        {
          name,
          keyHash,
          keyPrefix: rawKey.slice(0, 11), // "owk_" + first 7 chars for display
          createdAt: Date.now(),
          lastUsedAt: null,
        }
      );

      // Top-level lookup entry (for fast auth resolution — single doc read)
      batch.set(
        db.collection('apiKeys').doc(keyHash),
        { userId, keyId }
      );

      await batch.commit();

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
      });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/keys/create:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
