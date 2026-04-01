import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export class ApiAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireSession(request: NextRequest): Promise<string> {
  const session = await getSessionFromRequest(request);

  if (!session.userId || !session.expiresAt) {
    throw new ApiAuthError(401, 'Unauthorized: No valid session');
  }

  if (Date.now() > session.expiresAt) {
    session.destroy();
    throw new ApiAuthError(401, 'Unauthorized: Session expired');
  }

  return session.userId;
}

export async function requireSessionOrIdToken(
  request: NextRequest
): Promise<string> {
  try {
    return await requireSession(request);
  } catch (error) {
    const authHeader = request.headers.get('authorization') || '';
    const match = authHeader.match(/^Bearer\\s+(.+)$/i);
    if (!match) {
      if (error instanceof ApiAuthError) {
        throw error;
      }
      throw new ApiAuthError(401, 'Unauthorized: No valid session');
    }

    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(match[1]);
      return decoded.uid;
    } catch {
      throw new ApiAuthError(401, 'Unauthorized: Invalid ID token');
    }
  }
}

export async function requireAdmin(request: NextRequest): Promise<string> {
  const userId = await requireSession(request);
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const role = userDoc.exists ? userDoc.data()?.role : null;

  if (role !== 'admin') {
    throw new ApiAuthError(403, 'Forbidden: Admin access required');
  }

  return userId;
}

/**
 * Resolve a user ID from an API key (owk_...).
 * Looks up the SHA-256 hash in the top-level apiKeys collection (hash as doc ID → userId).
 * Updates lastUsedAt on the user's subcollection entry (fire-and-forget).
 */
async function resolveApiKey(rawKey: string): Promise<string> {
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const db = getAdminDb();

  // Single document read — no collection group query, no index needed
  const lookupDoc = await db.collection('apiKeys').doc(keyHash).get();

  if (!lookupDoc.exists) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  const { userId, keyId } = lookupDoc.data() as { userId: string; keyId: string };

  // Update lastUsedAt on the user's subcollection entry (fire-and-forget)
  db.collection('users').doc(userId).collection('apiKeys').doc(keyId)
    .update({ lastUsedAt: Date.now() }).catch(() => {});

  return userId;
}

export async function requireAdminOrIdToken(request: NextRequest): Promise<string> {
  // 1. Check for API key (query param or header)
  const apiKey =
    request.nextUrl.searchParams.get('api_key') ||
    request.headers.get('x-api-key') ||
    null;

  let userId: string;

  if (apiKey && apiKey.startsWith('owk_')) {
    userId = await resolveApiKey(apiKey);
  } else {
    userId = await requireSessionOrIdToken(request);
  }

  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const role = userDoc.exists ? userDoc.data()?.role : null;

  if (role !== 'admin') {
    throw new ApiAuthError(403, 'Forbidden: Admin access required');
  }

  return userId;
}

export async function requireSessionUser(
  request: NextRequest,
  userId: string
): Promise<string> {
  const sessionUserId = await requireSession(request);
  if (sessionUserId !== userId) {
    throw new ApiAuthError(403, 'Forbidden: User mismatch');
  }
  return sessionUserId;
}

export async function assertUserHasSiteAccess(
  userId: string,
  siteId: string
): Promise<{ siteId: string; siteData: Record<string, unknown> | null }> {
  const db = getAdminDb();

  const siteDoc = await db.collection('sites').doc(siteId).get();
  if (!siteDoc.exists) {
    throw new ApiAuthError(404, 'Site not found');
  }

  const siteData = siteDoc.data() || null;
  const isOwner = siteData?.owner === userId;

  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.exists ? userDoc.data() : null;
  const isAdmin = userData?.role === 'admin';
  const assignedSites = Array.isArray(userData?.sites) ? userData?.sites : [];
  const isAssigned = assignedSites.includes(siteId);

  if (!isAdmin && !isOwner && !isAssigned) {
    throw new ApiAuthError(403, 'Forbidden: You do not have access to this site');
  }

  return { siteId, siteData };
}
