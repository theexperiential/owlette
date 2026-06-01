/**
 * shared helpers for roost API routes (chunks/, roosts/).
 *
 * no URL or header versioning — the routes ARE the API. backward compat
 * with the legacy single-url distribution is NOT a goal; v3.0.0 agents
 * are required to consume new uploads (clean cutover).
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
import { checkRoostVersion } from '@/lib/versionHeader';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const MAX_HASHES_PER_REQUEST = 1000;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/* ------------------------------------------------------------------------- */
/*  legacy helpers kept for routes that still use requireAdminOrIdToken      */
/* ------------------------------------------------------------------------- */

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
 * Read the request body as text once, then JSON-parse. Returns both the
 * raw text (for idempotency body-hashing) and the parsed body.
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

/* ------------------------------------------------------------------------- */
/*  scope-aware auth helpers (roost public api wave 2)                       */
/* ------------------------------------------------------------------------- */

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
 * machine-scoped auth + scope check. used by `/api/sites/{siteId}/machines/{machineId}/...`
 * routes (api-sprint wave 2 — track 2A).
 *
 * - session/id-token callers: must have site access (membership / ownership /
 *   superadmin); scope check is bypassed (consistent with `requireScope`
 *   semantics for non-key auth).
 * - api-key callers: must additionally satisfy `machine=<machineId>:<permission>`.
 *   wildcard id (`machine=*`) matches any machineId.
 *
 * machineId validation matches siteId — 1-128 chars of letters / digits /
 * underscore / hyphen — since machine ids in this codebase have multiple
 * historical shapes (`mach_*`, hostnames, uuids).
 *
 * Skips `checkRoostVersion()` because machine endpoints are not part of the
 * roost (project distribution) surface and don't need the deprecation header.
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

  // Agent short-circuit: an agent's Firebase ID token carries role + site_id
  // + machine_id claims set by the device-code exchange. assertSiteAccessOrProblem
  // below reads users/{uid}.sites[] which agents don't have a doc in, so a plain
  // fall-through would 404 every agent screenshot/command call. Validate the
  // token's site_id and machine_id directly instead.
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
 * superadmin-gated platform-wide auth + scope check. used by routes that
 * operate on platform-level resources (`installer`, `user`) where access
 * is not site-scoped — only superadmins may call these endpoints, even
 * with a session or id-token.
 *
 * for api-key callers the scope check enforces `<resource>=*:<permission>`;
 * scope minting for `SUPERADMIN_ONLY_RESOURCES` is already restricted to
 * superadmins at key-creation time (wave 0.1), but we still re-verify the
 * caller's role here as defense-in-depth (e.g. the user could have been
 * demoted after the key was minted).
 *
 * for session/id-token callers, only the role check applies — they bypass
 * scope enforcement (consistent with `requireScope` semantics for non-key
 * auth).
 *
 * audit log emission for api-key callers uses `siteId=''` since platform
 * mutations have no site association.
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
  const role = userDoc.exists ? userDoc.data()?.role : null;
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
 * site-scoped Cortex conversation auth + scope check. used by
 * `/api/cortex/conversations/*`.
 *
 * - session/id-token callers: must have site access; scope check is bypassed.
 * - api-key callers: must satisfy `chat=<siteId>:<permission>`. wildcard id
 *   (`chat=*`) matches any siteId.
 *
 * Skips `checkRoostVersion()` because chat endpoints are not part of the
 * roost (project distribution) surface and don't need the deprecation header.
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
