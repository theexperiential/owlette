import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import {
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyResource,
  type ApiKeyScope,
  scopeMatches,
} from '@/lib/apiKeyTypes';
import { emitApiKeyUsed, scopeFingerprint } from '@/lib/auditLogClient';

export class ApiAuthError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    opts?: { code?: string; details?: Record<string, unknown> }
  ) {
    super(message);
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export interface ApiKeyContext {
  keyId: string;
  /** null for legacy pre-scoping keys (scopes field missing/empty). */
  scopes: ApiKeyScope[] | null;
  environment: ApiKeyEnvironment | null;
  expiresAt: number | null;
  /** True when the stored key has no scopes[] field — bypasses scope check with deprecation signal. */
  isLegacy: boolean;
  retiresAt?: number;
}

export interface ResolvedAuth {
  userId: string;
  /** Populated when the request was authed via an `owk_*` API key. Null for session / ID-token auth. */
  keyContext: ApiKeyContext | null;
}

export interface ScopeCheckResult {
  /** True when the check was bypassed because the key is a legacy (pre-scoping) key. */
  isLegacy: boolean;
  /** True when the request omitted Roost-Version. Caller should set X-Roost-Version-Missing. */
  missingVersion?: boolean;
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
    const bearer = extractBearer(request);
    if (!bearer) {
      if (error instanceof ApiAuthError) {
        throw error;
      }
      throw new ApiAuthError(401, 'Unauthorized: No valid session');
    }

    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(bearer);
      return decoded.uid;
    } catch {
      throw new ApiAuthError(401, 'Unauthorized: Invalid ID token');
    }
  }
}

export async function requireAdmin(request: NextRequest): Promise<string> {
  return requireAdminOrIdToken(request);
}

function extractBearer(request: NextRequest): string | null {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function extractApiKey(request: NextRequest): string | null {
  const queryOrHeader =
    request.nextUrl.searchParams.get('api_key') ||
    request.headers.get('x-api-key') ||
    null;
  if (queryOrHeader && queryOrHeader.startsWith('owk_')) return queryOrHeader;

  const bearer = extractBearer(request);
  if (bearer && bearer.startsWith('owk_')) return bearer;

  return null;
}

/**
 * Resolve an API key (owk_...) to full context: userId + keyContext.
 * One Firestore read (top-level api_keys/{keyHash}) + one fire-and-forget
 * lastUsedAt update on the user subcollection entry.
 */
async function resolveApiKeyContext(
  rawKey: string,
  options: { updateLastUsed?: boolean } = {},
): Promise<{ userId: string; keyContext: ApiKeyContext }> {
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const db = getAdminDb();

  const lookupDoc = await db.collection('api_keys').doc(keyHash).get();

  if (!lookupDoc.exists) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  const data = lookupDoc.data() as Partial<ApiKeyLookup> & {
    userId: string;
    keyId: string;
  };

  const now = Date.now();

  // Rotation grace: the old key's lookup entry carries `retiresAt` after
  // rotation. After retiresAt, treat as invalid.
  if (typeof data.retiresAt === 'number' && now >= data.retiresAt) {
    throw new ApiAuthError(401, 'Unauthorized: Invalid API key');
  }

  // Expiration: every scoped key has a hard `expiresAt`. Legacy pre-scoping
  // keys have no expiresAt — those pass through to the legacy-bypass path.
  if (typeof data.expiresAt === 'number' && now >= data.expiresAt) {
    throw new ApiAuthError(
      401,
      'Unauthorized: API key expired',
      {
        code: 'token_expired',
        details: { expiredAt: data.expiresAt },
      },
    );
  }

  const scopes = Array.isArray(data.scopes) ? (data.scopes as ApiKeyScope[]) : null;
  const isLegacy = !scopes || scopes.length === 0;

  const keyContext: ApiKeyContext = {
    keyId: data.keyId,
    scopes: isLegacy ? null : scopes,
    environment: (data.environment as ApiKeyEnvironment) ?? null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    isLegacy,
    ...(typeof data.retiresAt === 'number' ? { retiresAt: data.retiresAt } : {}),
  };

  if (options.updateLastUsed !== false) {
    db.collection('users')
      .doc(data.userId)
      .collection('api_keys')
      .doc(data.keyId)
      .update({ lastUsedAt: Date.now() })
      .catch(() => {});
  }

  return { userId: data.userId, keyContext };
}

export async function resolveApiKeyRateLimitIdentity(
  request: NextRequest,
): Promise<string | null> {
  const apiKey = extractApiKey(request);
  if (!apiKey) return null;

  try {
    const { keyContext } = await resolveApiKeyContext(apiKey, { updateLastUsed: false });
    return `apiKey:${keyContext.keyId}`;
  } catch {
    return null;
  }
}

async function resolveApiKey(rawKey: string): Promise<string> {
  const { userId } = await resolveApiKeyContext(rawKey);
  return userId;
}

export async function requireAdminOrIdToken(request: NextRequest): Promise<string> {
  const apiKey = extractApiKey(request);

  let userId: string;

  if (apiKey) {
    userId = await resolveApiKey(apiKey);
  } else {
    userId = await requireSessionOrIdToken(request);
  }

  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  const role = userDoc.exists ? userDoc.data()?.role : null;

  if (role !== 'superadmin') {
    throw new ApiAuthError(403, 'Forbidden: Superadmin access required');
  }

  return userId;
}

/**
 * Resolve request auth into a unified context that carries API-key metadata
 * when present. Use in public v2 routes that need scope enforcement.
 */
export async function resolveAuth(request: NextRequest): Promise<ResolvedAuth> {
  const apiKey = extractApiKey(request);

  if (apiKey) {
    const { userId, keyContext } = await resolveApiKeyContext(apiKey);
    return { userId, keyContext };
  }

  const userId = await requireSessionOrIdToken(request);
  return { userId, keyContext: null };
}

/**
 * Enforce that the resolved auth has the required scope.
 *
 * - Session / ID-token auth (no API key): bypassed. Dashboard users operate
 *   with full own access; per-resource access is enforced elsewhere.
 * - Legacy API key (no scopes[]): bypassed with a deprecation signal.
 *   Caller should add `X-Roost-Deprecation: legacy-key-scope-missing`.
 * - Scoped API key: requires a matching (resource, id, permission) entry.
 *   Wildcard id '*' in the stored scope matches any requested id.
 *
 * Throws ApiAuthError(403, code='scope_insufficient') on mismatch.
 */
export function requireScope(
  auth: ResolvedAuth,
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission
): ScopeCheckResult {
  if (!auth.keyContext) {
    return { isLegacy: false };
  }

  if (auth.keyContext.isLegacy || !auth.keyContext.scopes) {
    return { isLegacy: true };
  }

  if (scopeMatches(auth.keyContext.scopes, resource, id, permission)) {
    return { isLegacy: false };
  }

  throw new ApiAuthError(
    403,
    `insufficient scope: requires ${permission} on ${resource}:${id}`,
    {
      code: 'scope_insufficient',
      details: { resource, id, permission },
    }
  );
}

/**
 * Attach the legacy-key deprecation header + version-missing advisory
 * header to a response based on the scope-check result.
 */
export function applyAuthDeprecations(
  response: NextResponse,
  check: ScopeCheckResult
): NextResponse {
  if (check.isLegacy) {
    response.headers.append('X-Roost-Deprecation', 'legacy-key-scope-missing');
  }
  if (check.missingVersion) {
    response.headers.set('X-Roost-Version-Missing', 'true');
  }
  return response;
}

/**
 * Fire-and-forget `api_key_used` audit event. No-op for session/id-token auth.
 */
export function auditApiKeyUse(
  auth: ResolvedAuth,
  siteId: string,
  request: NextRequest,
): void {
  const kc = auth.keyContext;
  if (!kc) return;
  emitApiKeyUsed({
    siteId,
    keyId: kc.keyId,
    scopeFingerprint: scopeFingerprint(kc.scopes),
    environment: kc.environment ?? 'unknown',
    endpoint: request.nextUrl.pathname,
    method: request.method,
    isLegacy: kc.isLegacy,
  });
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
  const isSuperadmin = userData?.role === 'superadmin';
  const assignedSites = Array.isArray(userData?.sites) ? userData?.sites : [];
  const isAssigned = assignedSites.includes(siteId);

  if (!isSuperadmin && !isOwner && !isAssigned) {
    throw new ApiAuthError(403, 'Forbidden: You do not have access to this site');
  }

  return { siteId, siteData };
}
