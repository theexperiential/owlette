/**
 * Shared API Helpers
 *
 * Combines common auth + site access checks into a single call to reduce
 * redundant Firestore reads (requireAdminOrIdToken reads user doc for role,
 * then assertUserHasSiteAccess reads it again — this eliminates the duplicate).
 *
 * Also provides URL param extraction for dynamic routes.
 */

import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { ApiAuthError } from '@/lib/apiAuth.server';

/**
 * Resolves user ID from API key, session, or ID token — plus validates
 * admin role and site access in a single pass (2 Firestore reads instead of 3).
 */
export async function requireAdminWithSiteAccess(
  request: NextRequest,
  siteId: string
): Promise<{ userId: string }> {
  const userId = await resolveUserId(request);
  const db = getAdminDb();

  // Single user doc read for both role check and site access
  const [userDoc, siteDoc] = await Promise.all([
    db.collection('users').doc(userId).get(),
    db.collection('sites').doc(siteId).get(),
  ]);

  if (!siteDoc.exists) {
    throw new ApiAuthError(404, 'Site not found');
  }

  const userData = userDoc.exists ? userDoc.data() : null;
  const role = userData?.role;

  if (role !== 'admin') {
    // Non-admin: check site access
    const siteData = siteDoc.data() || {};
    const isOwner = siteData.owner === userId;
    const assignedSites = Array.isArray(userData?.sites) ? userData?.sites : [];
    const isAssigned = assignedSites.includes(siteId);

    if (!isOwner && !isAssigned) {
      throw new ApiAuthError(403, 'Forbidden: You do not have access to this site');
    }
  }

  return { userId };
}

/**
 * Resolve user ID from the request using API key, session, or ID token.
 * Does NOT check role or site access — use requireAdminWithSiteAccess for that.
 */
async function resolveUserId(request: NextRequest): Promise<string> {
  // 1. Check for API key
  const apiKey =
    request.nextUrl.searchParams.get('api_key') ||
    request.headers.get('x-api-key') ||
    null;

  if (apiKey && apiKey.startsWith('owk_')) {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const db = getAdminDb();
    const lookupDoc = await db.collection('apiKeys').doc(keyHash).get();

    if (!lookupDoc.exists) {
      throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
    }

    const { userId, keyId } = lookupDoc.data() as { userId: string; keyId: string };

    // Update lastUsedAt (fire-and-forget)
    db.collection('users').doc(userId).collection('apiKeys').doc(keyId)
      .update({ lastUsedAt: Date.now() }).catch(() => {});

    return userId;
  }

  // 2. Try session
  try {
    const session = await getSessionFromRequest(request);
    if (session.userId && session.expiresAt && Date.now() <= session.expiresAt) {
      return session.userId;
    }
  } catch {
    // Session failed, try ID token
  }

  // 3. Try Firebase ID token
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(match[1]);
      return decoded.uid;
    } catch {
      throw new ApiAuthError(401, 'Unauthorized: Invalid ID token');
    }
  }

  throw new ApiAuthError(401, 'Unauthorized: No valid session, API key, or ID token');
}

/**
 * Extract a dynamic route parameter from the URL pathname.
 *
 * Example: getRouteParam(request, 4) for /api/admin/processes/{processId}
 * returns the value at segment index 4.
 */
export function getRouteParam(request: NextRequest, segmentIndex: number): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const value = segments[segmentIndex];

  if (!value) {
    throw new ApiAuthError(400, `Missing required route parameter at segment ${segmentIndex}`);
  }

  return decodeURIComponent(value);
}
