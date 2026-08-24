/**
 * Shared helpers for roost API routes (chunks/, roosts/).
 *
 * No URL or header versioning — the routes ARE the API. No backward compat with
 * legacy single-url distribution: v3.0.0 agents are required (clean cutover).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemValidation,
  problemUnauthorized,
  problemForbidden,
  problemNotFound,
  problemScopeInsufficient,
  problemTokenExpired,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  applyAuthDeprecations,
  auditApiKeyUse,
  requireAdminOrIdToken,
  requireScope,
  resolveAuth,
  assertUserHasSiteAccess,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import type { ApiKeyPermission, ApiKeyResource } from '@/lib/apiKeyTypes';
import {
  Capability,
  hasCapability,
  type Role,
  type UserActor,
} from '@/lib/capabilities';
import { checkRoostVersion } from '@/lib/versionHeader';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const MAX_HASHES_PER_REQUEST = 1000;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// legacy helpers, for routes still on requireAdminOrIdToken

export async function requireAuthOrProblem(
  req: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  try {
    const userId = await requireAdminOrIdToken(req);
    return { ok: true, userId };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 403) return { ok: false, response: problemForbidden() };
      if (err.status === 404) return { ok: false, response: problemNotFound() };
      return { ok: false, response: problemUnauthorized() };
    }
    throw err;
  }
}

export async function requireAgentOrSiteScope(
  req: NextRequest,
  siteId: string,
): Promise<{ ok: true; userId: string; isAgent: boolean } | { ok: false; response: NextResponse }> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(match[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return { ok: true, userId: decoded.uid, isAgent: true };
      }
    } catch {
      /* fall through */
    }
  }

  const auth = await requireAuthOrProblem(req);
  if (!auth.ok) return { ok: false, response: auth.response };
  const scopeError = await requireSiteScope(auth.userId, siteId);
  if (scopeError) return { ok: false, response: scopeError };
  return { ok: true, userId: auth.userId, isAgent: false };
}

export async function requireSiteScope(
  userId: string,
  siteId: string,
): Promise<NextResponse | null> {
  if (!SITE_ID_RE.test(siteId)) {
    return problemValidation('invalid siteId format', {
      siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
    });
  }
  try {
    await assertUserHasSiteAccess(userId, siteId);
    return null;
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 404 || err.status === 403) {
        return problemNotFound('site not found or no access');
      }
      return problemForbidden();
    }
    throw err;
  }
}

export function validateResourceId(id: string, fieldName: string): NextResponse | null {
  if (!RESOURCE_ID_RE.test(id)) {
    return problemValidation(
      `${fieldName} must be 8-64 chars: letters, digits, underscore, hyphen`,
      { [fieldName]: ['invalid format'] },
    );
  }
  return null;
}

export function validateSiteIdBody(value: unknown, fieldName = 'siteId'):
  | { ok: true; siteId: string }
  | { ok: false; response: NextResponse } {
  if (typeof value !== 'string' || !SITE_ID_RE.test(value)) {
    return {
      ok: false,
      response: problemValidation(`field ${fieldName} is required and must be a valid site id`, {
        [fieldName]: ['must be a non-empty string, ≤128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  return { ok: true, siteId: value };
}

export function validateHashList(value: unknown, fieldName: string):
  | { ok: true; hashes: string[] }
  | { ok: false; response: NextResponse } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} must be a non-empty array of sha-256 hashes`,
        { [fieldName]: ['must be a non-empty array of sha-256 hex strings'] },
      ),
    };
  }
  if (value.length > MAX_HASHES_PER_REQUEST) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} contains ${value.length} hashes; max is ${MAX_HASHES_PER_REQUEST} per request`,
        { [fieldName]: [`max ${MAX_HASHES_PER_REQUEST} hashes per request`] },
      ),
    };
  }
  const bad: string[] = [];
  for (const h of value) {
    if (typeof h !== 'string' || !SHA256_HEX_RE.test(h)) {
      bad.push(String(h).slice(0, 16) + '…');
      if (bad.length >= 5) break;
    }
  }
  if (bad.length) {
    return {
      ok: false,
      response: problemValidation(
        `field ${fieldName} contains malformed hash entries (must be lowercase 64-char hex sha-256)`,
        { [fieldName]: [`malformed entries: ${bad.join(', ')}`] },
      ),
    };
  }
  return { ok: true, hashes: value as string[] };
}

export async function parseJsonBody(
  req: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json();
    return { ok: true, body };
  } catch {
    return { ok: false, response: problemValidation('request body is not valid json') };
  }
}

/**
 * Read the body as text once, then JSON-parse. Returns both — the raw text is
 * what idempotency body-hashing needs.
 */
export async function readAndParseJsonBody(
  req: NextRequest,
): Promise<
  | { ok: true; raw: string; body: unknown }
  | { ok: false; response: NextResponse }
> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: problemValidation('could not read request body') };
  }
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, response: problemValidation('request body is not valid json') };
    }
  }
  return { ok: true, raw, body };
}

// scope-aware auth helpers

export interface ScopedAuthSuccess {
  ok: true;
  userId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export type ScopedAuthResult =
  | ScopedAuthSuccess
  | { ok: false; response: NextResponse };

export function auditActorIdentifier(auth: ResolvedAuth): string {
  return auth.keyContext ? `apiKey:${auth.keyContext.keyId}` : `user:${auth.userId}`;
}

async function resolveAuthOrProblem(
  req: NextRequest,
): Promise<{ ok: true; auth: ResolvedAuth } | { ok: false; response: NextResponse }> {
  try {
    const auth = await resolveAuth(req);
    return { ok: true, auth };
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.code === 'token_expired') {
        const expiredAt =
          typeof err.details?.expiredAt === 'number' ? err.details.expiredAt : undefined;
        return { ok: false, response: problemTokenExpired(expiredAt) };
      }
      if (err.status === 403) return { ok: false, response: problemForbidden() };
      if (err.status === 404) return { ok: false, response: problemNotFound() };
      return { ok: false, response: problemUnauthorized() };
    }
    throw err;
  }
}

function runScopeCheck(
  auth: ResolvedAuth,
  resource: ApiKeyResource,
  id: string,
  permission: ApiKeyPermission,
): { ok: true; scopeCheck: ScopeCheckResult } | { ok: false; response: NextResponse } {
  try {
    const scopeCheck = requireScope(auth, resource, id, permission);
    return { ok: true, scopeCheck };
  } catch (err) {
    if (err instanceof ApiAuthError && err.code === 'scope_insufficient') {
      return {
        ok: false,
        response: problemScopeInsufficient(err.message, {
          resource,
          id,
          permission,
        }),
      };
    }
    throw err;
  }
}

function authToActor(auth: ResolvedAuth, role: Role, sites: string[]): UserActor {
  return {
    type: 'user',
    userId: auth.userId,
    ...(auth.keyContext ? { apiKeyId: auth.keyContext.keyId } : {}),
    role,
    sites,
  };
}

async function loadUserActor(auth: ResolvedAuth): Promise<UserActor> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(auth.userId).get();
  const data = userDoc.exists ? userDoc.data() : null;
  const rawRole = data?.role;
  const role: Role = rawRole === 'superadmin' || rawRole === 'admin' ? rawRole : 'member';
  const sites = Array.isArray(data?.sites)
    ? (data?.sites as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return authToActor(auth, role, sites);
}

export async function requireDistributionManageCapability(
  auth: ResolvedAuth,
  siteId: string,
): Promise<NextResponse | null> {
  const siteSnap = await getAdminDb().collection('sites').doc(siteId).get();
  const siteData = siteSnap.exists ? siteSnap.data() : null;
  if (siteData?.owner === auth.userId) return null;

  const actor = await loadUserActor(auth);
  if (!hasCapability(actor, Capability.DISTRIBUTION_MANAGE, siteId)) {
    return problemForbidden('capability not granted');
  }
  return null;
}

function isMutationPermission(permission: ApiKeyPermission): boolean {
  return permission !== 'read';
}

async function assertSiteAccessOrProblem(
  userId: string,
  siteId: string,
): Promise<NextResponse | null> {
  try {
    await assertUserHasSiteAccess(userId, siteId);
    return null;
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.status === 404 || err.status === 403) {
        return problemNotFound('site not found or no access');
      }
      return problemForbidden();
    }
    throw err;
  }
}

export async function requireSiteAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const versionCheck = checkRoostVersion(req);
  if (!versionCheck.ok) return { ok: false, response: versionCheck.response };

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const accessError = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (accessError) return { ok: false, response: accessError };

  const scopeResult = runScopeCheck(authResult.auth, 'site', siteId, permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: { ...scopeResult.scopeCheck, missingVersion: versionCheck.missing },
  };
}

/**
 * Machine-scoped auth + scope check for
 * `/api/sites/{siteId}/machines/{machineId}/...`.
 *
 * - session/id-token: needs site access; scope check bypassed (same as
 *   `requireScope` for non-key auth).
 * - api-key: must also satisfy `machine=<machineId>:<permission>`; `machine=*`
 *   matches any id.
 *
 * machineId validation matches siteId (1-128 of [A-Za-z0-9_-]) because machine
 * ids have several historical shapes (`mach_*`, hostnames, uuids).
 *
 * No `checkRoostVersion()` — machine endpoints aren't part of the roost surface
 * and take no deprecation header.
 */
export async function requireMachineAuthAndScope(
  req: NextRequest,
  siteId: string,
  machineId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  if (!SITE_ID_RE.test(machineId)) {
    return {
      ok: false,
      response: problemValidation('invalid machineId format', {
        machineId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  // Agent short-circuit: an agent ID token carries role + site_id + machine_id
  // claims, but assertSiteAccessOrProblem reads users/{uid}.sites[] and agents
  // have no user doc — falling through would 404 every agent screenshot/command
  // call. Validate the token's claims directly instead.
  const authHeader = req.headers.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && !bearerMatch[1].startsWith('owk_')) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(bearerMatch[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId || decoded.machine_id !== machineId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return {
          ok: true,
          userId: decoded.uid,
          auth: { userId: decoded.uid, keyContext: null },
          scopeCheck: { isLegacy: false },
        };
      }
    } catch {
      /* not an agent id token — fall through to standard resolveAuthOrProblem */
    }
  }

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const accessError = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (accessError) return { ok: false, response: accessError };

  const scopeResult = runScopeCheck(authResult.auth, 'machine', machineId, permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

export async function requireRoostAuthAndScope(
  req: NextRequest,
  siteId: string,
  roostId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }
  if (!RESOURCE_ID_RE.test(roostId)) {
    return {
      ok: false,
      response: problemValidation(
        'roostId must be 8-64 chars: letters, digits, underscore, hyphen',
        { roostId: ['invalid format'] },
      ),
    };
  }

  const versionCheck = checkRoostVersion(req);
  if (!versionCheck.ok) return { ok: false, response: versionCheck.response };

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const accessError = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (accessError) return { ok: false, response: accessError };

  if (isMutationPermission(permission)) {
    const capabilityError = await requireDistributionManageCapability(authResult.auth, siteId);
    if (capabilityError) return { ok: false, response: capabilityError };
  }

  const scopeResult = runScopeCheck(authResult.auth, 'roost', roostId, permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: { ...scopeResult.scopeCheck, missingVersion: versionCheck.missing },
  };
}

/**
 * Superadmin-gated platform-wide auth + scope check, for non-site-scoped
 * resources (`installer`, `user`). Superadmin only, even with a session.
 *
 * api-key callers additionally need `<resource>=*:<permission>`. Minting scopes
 * for `SUPERADMIN_ONLY_RESOURCES` is already superadmin-restricted at key
 * creation, but the role is re-verified here as defense-in-depth: the user may
 * have been demoted since the key was minted.
 *
 * session/id-token callers get the role check only (scope bypassed, as
 * elsewhere). Audit emission uses `siteId=''` — platform mutations have no site.
 */
export async function requirePlatformAuthAndScope(
  req: NextRequest,
  resource: ApiKeyResource,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  // role gate: platform endpoints require superadmin regardless of scope.
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(authResult.auth.userId).get();
  const userData = userDoc.exists ? userDoc.data() : null;
  if (typeof userData?.deletedAt === 'number') {
    return { ok: false, response: problemForbidden('user is deleted or inactive') };
  }
  const role = userData?.role ?? null;
  if (role !== 'superadmin') {
    return { ok: false, response: problemForbidden('superadmin access required') };
  }

  // scope gate (api-key callers only; session/id-token bypasses).
  const scopeResult = runScopeCheck(authResult.auth, resource, '*', permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, '', req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

/**
 * Site-scoped Hoot conversation auth + scope check for
 * `/api/hoot/conversations/*`. session/id-token: site access, scope bypassed.
 * api-key: `chat=<siteId>:<permission>`, `chat=*` matches any siteId.
 *
 * No `checkRoostVersion()` — chat isn't part of the roost surface.
 */
export async function requireChatAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<ScopedAuthResult> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authResult = await resolveAuthOrProblem(req);
  if (!authResult.ok) return authResult;

  const accessError = await assertSiteAccessOrProblem(authResult.auth.userId, siteId);
  if (accessError) return { ok: false, response: accessError };

  const scopeResult = runScopeCheck(authResult.auth, 'chat', siteId, permission);
  if (!scopeResult.ok) return scopeResult;

  auditApiKeyUse(authResult.auth, siteId, req);

  return {
    ok: true,
    userId: authResult.auth.userId,
    auth: authResult.auth,
    scopeCheck: scopeResult.scopeCheck,
  };
}

export async function requireAgentOrSiteAuthAndScope(
  req: NextRequest,
  siteId: string,
  permission: ApiKeyPermission,
): Promise<
  | { ok: true; userId: string; isAgent: boolean; scopeCheck: ScopeCheckResult }
  | { ok: false; response: NextResponse }
> {
  if (!SITE_ID_RE.test(siteId)) {
    return {
      ok: false,
      response: problemValidation('invalid siteId format', {
        siteId: ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      }),
    };
  }

  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && !match[1].startsWith('owk_')) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(match[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId) {
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return {
          ok: true,
          userId: decoded.uid,
          isAgent: true,
          scopeCheck: { isLegacy: false },
        };
      }
    } catch {
      /* fall through */
    }
  }

  const operator = await requireSiteAuthAndScope(req, siteId, permission);
  if (!operator.ok) return operator;

  return {
    ok: true,
    userId: operator.userId,
    isAgent: false,
    scopeCheck: operator.scopeCheck,
  };
}

export { applyAuthDeprecations };
