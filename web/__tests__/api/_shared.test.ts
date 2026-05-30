/**
 * @jest-environment node
 *
 * tests for the shared helpers in web/app/api/v2/_shared.ts.
 *
 * the auth-mapping branches in particular were silently broken in round 1
 * (used `err.statusCode` instead of `err.status` from ApiAuthError) — this
 * file catches that class of regression.
 */
import { NextRequest } from 'next/server';

// mock auth helpers BEFORE importing the module under test, so the module's
// `import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess }`
// resolves to our controllable versions.
jest.mock('@/lib/apiAuth.server', () => {
  // declare ApiAuthError exactly as the real module does — `status` field,
  // not `statusCode`.
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiAuthError,
    requireAdminOrIdToken: jest.fn(),
    assertUserHasSiteAccess: jest.fn(),
  };
});

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import {
  ApiAuthError,
  requireAdminOrIdToken,
  assertUserHasSiteAccess,
} from '@/lib/apiAuth.server';
import {
  parseJsonBody,
  validateHashList,
  validateResourceId,
  validateSiteIdBody,
  requireAuthOrProblem,
  requireSiteScope,
  MAX_HASHES_PER_REQUEST,
} from '@/app/api/_shared';

const mockedRequireAuth = requireAdminOrIdToken as jest.MockedFunction<typeof requireAdminOrIdToken>;
const mockedAssertSite = assertUserHasSiteAccess as jest.MockedFunction<typeof assertUserHasSiteAccess>;

function makeRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
} = {}): NextRequest {
  return new NextRequest(new URL(opts.url ?? 'http://localhost/api/v2/test'), {
    headers: opts.headers,
    method: opts.method ?? 'GET',
    body: opts.body,
  });
}

describe('_shared.ts (v2 route helpers)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  // (checkAcceptHeader was removed when the API dropped URL+header dual
  // versioning. there is no /api/v2/ prefix anymore — the routes ARE the
  // API. tests deleted along with the helper.)

  // ─── requireAuthOrProblem ─────────────────────────────────────────

  describe('requireAuthOrProblem', () => {
    it('returns ok with userId when auth succeeds', async () => {
      mockedRequireAuth.mockResolvedValueOnce('user-abc');
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.userId).toBe('user-abc');
    });

    it('maps ApiAuthError(403) → 403 problemForbidden (NOT 401)', async () => {
      // round-1 regression: used err.statusCode (undefined) → fell through
      // to 401. this test would have caught it.
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(403, 'forbidden'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });

    it('maps ApiAuthError(404) → 404 problemNotFound (NOT 401)', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(404, 'site missing'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(404);
      }
    });

    it('maps ApiAuthError(401) → 401 problemUnauthorized', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(401, 'no token'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
    });

    it('does NOT echo err.message in the response (no info leak)', async () => {
      mockedRequireAuth.mockRejectedValueOnce(
        new ApiAuthError(403, 'SECRET internal detail with siteId site_xyz'),
      );
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body.detail ?? '').not.toContain('SECRET');
        expect(body.detail ?? '').not.toContain('site_xyz');
      }
    });

    it('rethrows non-ApiAuthError', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new Error('unrelated'));
      const req = makeRequest();
      await expect(requireAuthOrProblem(req)).rejects.toThrow('unrelated');
    });
  });

  // ─── requireSiteScope ─────────────────────────────────────────────

  describe('requireSiteScope', () => {
    it('returns null when the user has access', async () => {
      mockedAssertSite.mockResolvedValueOnce({ siteId: 'site_abc', siteData: null });
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).toBeNull();
    });

    it('rejects malformed siteId with 400 (no firestore call)', async () => {
      const result = await requireSiteScope('user-1', '../../etc/passwd');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(400);
      expect(mockedAssertSite).not.toHaveBeenCalled();
    });

    it('collapses 404 (site not found) → 404 problemNotFound (anti-enumeration)', async () => {
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(404, 'site not found'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(404);
    });

    it('collapses 403 (forbidden) → 404 problemNotFound (anti-enumeration)', async () => {
      // round-1 regression: 403 fell through to problemForbidden(err.message)
      // — leaking message AND failing the anti-enumeration design.
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(403, 'forbidden — siteId site_xyz'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(404);
      const body = await result!.json();
      // verify no info leak
      expect(JSON.stringify(body)).not.toContain('site_xyz');
    });

    it('falls back to generic 403 for other ApiAuthError statuses', async () => {
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(500, 'INTERNAL SECRET'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
      const body = await result!.json();
      expect(JSON.stringify(body)).not.toContain('SECRET');
    });

    it('rethrows non-ApiAuthError', async () => {
      mockedAssertSite.mockRejectedValueOnce(new Error('unrelated'));
      await expect(requireSiteScope('user-1', 'site_abc')).rejects.toThrow('unrelated');
    });
  });

  // ─── validateResourceId ──────────────────────────────────────────

  describe('validateResourceId', () => {
    it('accepts valid 8-64 char ids', () => {
      expect(validateResourceId('abcd1234', 'roostId')).toBeNull();
      expect(validateResourceId('a-b_c-1234567890', 'roostId')).toBeNull();
    });
    it('rejects too-short', () => {
      const res = validateResourceId('short', 'roostId');
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
    it('rejects too-long (>64)', () => {
      const res = validateResourceId('a'.repeat(65), 'roostId');
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
    it('rejects characters outside [A-Za-z0-9_-]', () => {
      expect(validateResourceId('abc/def12345', 'f')).not.toBeNull();
      expect(validateResourceId('abc.def12345', 'f')).not.toBeNull();
      expect(validateResourceId('abc def12345', 'f')).not.toBeNull();
    });
  });

  // ─── validateSiteIdBody ──────────────────────────────────────────

  describe('validateSiteIdBody', () => {
    it('accepts valid siteId strings', () => {
      const r = validateSiteIdBody('site_abc_123');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.siteId).toBe('site_abc_123');
    });
    it('rejects undefined', () => {
      const r = validateSiteIdBody(undefined);
      expect(r.ok).toBe(false);
    });
    it('rejects non-string', () => {
      const r = validateSiteIdBody(123);
      expect(r.ok).toBe(false);
    });
    it('rejects empty string', () => {
      const r = validateSiteIdBody('');
      expect(r.ok).toBe(false);
    });
    it('uses custom field name in error', async () => {
      const r = validateSiteIdBody(undefined, 'query.siteId');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const body = await r.response.json();
        expect(JSON.stringify(body.errors)).toContain('query.siteId');
      }
    });
  });

  // ─── validateHashList ────────────────────────────────────────────

  describe('validateHashList', () => {
    const validHash = 'a'.repeat(64);

    it('accepts a valid array of sha-256 hex hashes', () => {
      const r = validateHashList([validHash, 'b'.repeat(64)], 'hashes');
      expect(r.ok).toBe(true);
    });

    it('rejects empty array', () => {
      const r = validateHashList([], 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects non-array', () => {
      const r = validateHashList('not an array', 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects entries that are not 64-char lowercase hex', () => {
      const r = validateHashList([validHash, 'UPPERCASE_HEX_64_BYTES_INVALID', validHash], 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects > MAX_HASHES_PER_REQUEST entries', () => {
      const arr = Array(MAX_HASHES_PER_REQUEST + 1).fill(validHash);
      const r = validateHashList(arr, 'hashes');
      expect(r.ok).toBe(false);
    });

    it('accepts exactly MAX_HASHES_PER_REQUEST entries', () => {
      const arr = Array(MAX_HASHES_PER_REQUEST).fill(validHash);
      const r = validateHashList(arr, 'hashes');
      expect(r.ok).toBe(true);
    });
  });

  // ─── parseJsonBody ──────────────────────────────────────────────

  describe('parseJsonBody', () => {
    it('parses valid json body', async () => {
      const req = makeRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"x":1}',
      });
      const r = await parseJsonBody(req);
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.body as { x: number }).x).toBe(1);
    });

    it('returns 400 on invalid json', async () => {
      const req = makeRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid',
      });
      const r = await parseJsonBody(req);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(400);
    });
  });
});
