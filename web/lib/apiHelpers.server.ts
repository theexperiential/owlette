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
 * Canonical site-membership read.
 *
 * Owlette stores site membership exclusively on `users/{uid}.sites[]`. There
 * is no inverse `sites/{siteId}.members[]` collection — this was audited in
 * `dev/active/api-sprint/reference/membership-decision.md`. Every caller that
 * needs "what sites does this user belong to?" should go through this helper
 * so the read shape is identical across api-sprint waves and Firestore-rules
 * stays the only place that pins to the underlying field.
 *
 * Returns `[]` for users with no `sites` field (e.g. brand-new accounts) and
 * for users whose doc doesn't exist. Superadmins still have access to every
 * site via the role check elsewhere — this returns the explicit assignment
 * list, not the effective access list.
 */
export async function getUserSiteIds(userId: string): Promise<string[]> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return [];
  const data = userDoc.data();
  const sites = data?.sites;
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Resolves user ID from API key, session, or ID token — plus validates
 * site-admin access in a single pass (2 Firestore reads instead of 3).
 *
 * Mirrors the canonical client-side `isSiteAdmin(siteId)` check
 * (see AuthContext): a caller is a site admin iff
 *   role === 'superadmin', OR
 *   role === 'admin' AND (they own the site OR siteId is in their users.sites[]).
 *
 * Plain `member` role — even with site access — is rejected. These routes
 * back `/api/admin/*` endpoints and must not expose admin surface to members.
 */
export async function requireAdminWithSiteAccess(
  request: NextRequest,
  siteId: string
): Promise<{ userId: string }> {
  const userId = await resolveUserId(request);
  const db = getAdminDb();

  const [userDoc, siteDoc] = await Promise.all([
    db.collection('users').doc(userId).get(),
    db.collection('sites').doc(siteId).get(),
  ]);

  if (!siteDoc.exists) {
    throw new ApiAuthError(404, 'Site not found');
  }

  const userData = userDoc.exists ? userDoc.data() : null;
  const role = userData?.role;

  if (role === 'superadmin') {
    return { userId };
  }

  if (role === 'admin') {
    const siteData = siteDoc.data() || {};
    const isOwner = siteData.owner === userId;
    const assignedSites = Array.isArray(userData?.sites) ? userData?.sites : [];
    const isAssigned = assignedSites.includes(siteId);

    if (isOwner || isAssigned) {
      return { userId };
    }
  }

  throw new ApiAuthError(403, 'Forbidden: Site admin access required');
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
    const lookupDoc = await db.collection('api_keys').doc(keyHash).get();

    if (!lookupDoc.exists) {
      throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
    }

    const { userId, keyId } = lookupDoc.data() as { userId: string; keyId: string };

    // Update lastUsedAt (fire-and-forget)
    db.collection('users').doc(userId).collection('api_keys').doc(keyId)
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
