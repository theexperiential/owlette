/**
 * shared helpers for roost API routes (chunks/, folders/).
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
  problem,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  requireAdminOrIdToken,
  assertUserHasSiteAccess,
} from '@/lib/apiAuth.server';
import { getAdminAuth } from '@/lib/firebase-admin';

export const MAX_HASHES_PER_REQUEST = 1000;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * NOTE: ApiAuthError exposes `status` (NOT `statusCode`). The previous
 * typo silently bypassed every status mapping. Generic problem messages
 * here (no `err.message` echo) to avoid leaking internal error text.
 */
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

/**
 * Auth gate for roost endpoints that BOTH operators (from the web UI)
 * AND agents need to call (manifest/chunk URL minting, etc.).
 *
 * - Operator path: the existing superadmin-or-site-member check
 *   (`requireAuthOrProblem` → `requireSiteScope`). Same behaviour as
 *   every other roost API.
 * - Agent path: decode the bearer token directly; if the custom claims
 *   show `role: 'agent'` AND `site_id` matches the requested siteId,
 *   allow. Agents don't have `users/{uid}` docs so `assertUserHasSiteAccess`
 *   would always fail for them — scoping is entirely by token claim.
 *
 * Call this INSTEAD OF the requireAuthOrProblem + requireSiteScope pair
 * when the endpoint is on the agent's hot path.
 */
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

  // Try the agent-token path first — cheap decode, no firestore round-trip
  // on the happy path for the common agent caller.
  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(match[1]);
      if (decoded.role === 'agent') {
        if (decoded.site_id !== siteId) {
          // Agent token scoped to a different site — treat as not-found
          // to match the anti-enumeration posture of requireSiteScope.
          return { ok: false, response: problemNotFound('site not found or no access') };
        }
        return { ok: true, userId: decoded.uid, isAgent: true };
      }
      // Non-agent bearer token — fall through to the operator path so the
      // superadmin check can still happen via requireAdminOrIdToken.
    } catch {
      // Invalid token — let the operator path produce the 401.
    }
  }

  // Operator path — reuse the existing helpers so behaviour stays consistent.
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
      // collapse 404 + 403 to 404 (anti-enumeration); never echo err.message.
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
