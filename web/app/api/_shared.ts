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
  problem,
  ProblemType,
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
import { getAdminAuth } from '@/lib/firebase-admin';

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

export function notImplementedYet(
  endpoint: string,
  wave: string,
  todo: string,
): NextResponse {
  return problem({
    type: ProblemType.ServiceUnavailable,
    title: 'not implemented yet (stub)',
    status: 503,
    detail: `${endpoint} is scaffolded but not yet wired to backing services. roost ${wave}.`,
    instance: endpoint,
    todo,
  });
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
