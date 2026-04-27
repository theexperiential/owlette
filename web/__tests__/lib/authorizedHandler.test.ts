/** @jest-environment node */

/**
 * Unit tests for `web/lib/authorizedHandler.server.ts` — the
 * `authorizedSiteHandler` and `authorizedPlatformHandler` wrappers.
 *
 * Coverage targets:
 *   - happy path: handler invoked with the right ctx
 *   - allow-audit blocking: audit failure -> 503, handler not called
 *   - capability kill switch bypass + bypass metadata
 *   - rate-limit kill switch bypass + bypass metadata
 *   - api-key scope check NEVER bypassed (read-only key + both kill switches off → 403)
 *   - site access denied -> 404
 *   - capability denied -> 403 + deny audit
 *   - rate-limit denied -> 429 + deny audit
 *   - platform handler: superadmin gate + audits to global path
 *   - typescript: `siteIdParam: 'body'` is a build error
 */

import type { NextRequest } from 'next/server';

const setCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
let setShouldReject: Error | null = null;

let userDoc: { exists: boolean; data: () => unknown } = {
  exists: true,
  data: () => ({ role: 'admin', sites: ['site-a'] }),
};
let siteDoc: { exists: boolean; data: () => unknown } = {
  exists: true,
  data: () => ({ owner: 'uid_alice' }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => buildCollection(top),
  }),
}));

function buildCollection(path: string): unknown {
  return {
    doc: (id?: string) => buildDoc(`${path}/${id ?? 'auto'}`),
  };
}

function buildDoc(path: string): unknown {
  return {
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
    get: () => {
      // resolve which doc this is
      if (path.startsWith('users/')) {
        return Promise.resolve(userDoc);
      }
      if (path.startsWith('sites/')) {
        return Promise.resolve(siteDoc);
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (payload: Record<string, unknown>) => {
      if (setShouldReject) return Promise.reject(setShouldReject);
      setCalls.push({ path, payload });
      return Promise.resolve();
    },
  };
}

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

let configResult = {
  capability_enforcement: true,
  rate_limit_enforcement: true,
  lastUpdated: 0,
  expiresAt: 0,
};
const securityConfigReadSpy = jest.fn(async () => configResult);
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: { read: () => securityConfigReadSpy() },
}));

let rateLimitResult: { ok: boolean; reason?: 'rate_limited'; retryAfterSec?: number } = { ok: true };
const checkRateLimitSpy = jest.fn(async () => rateLimitResult);
jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: () => checkRateLimitSpy(),
}));

let resolveAuthResult: { userId: string; keyContext: unknown } = { userId: 'uid_alice', keyContext: null };
let resolveAuthThrows: { status: number; message: string; code?: string; details?: Record<string, unknown> } | null = null;

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthErrorMock extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      message: string,
      opts?: { code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }
  return {
    ApiAuthError: ApiAuthErrorMock,
    resolveAuth: jest.fn(async () => {
      if (resolveAuthThrows) {
        throw new ApiAuthErrorMock(resolveAuthThrows.status, resolveAuthThrows.message, {
          code: resolveAuthThrows.code,
          details: resolveAuthThrows.details,
        });
      }
      return resolveAuthResult;
    }),
    requireScope: jest.fn(),
    assertUserHasSiteAccess: jest.fn(async () => ({ siteId: 'site-a', siteData: {} })),
  };
});

const warnSpy = jest.fn();
const errorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
  },
}));

import { NextResponse } from 'next/server';
import {
  authorizedSiteHandler,
  authorizedPlatformHandler,
  type SiteIdSource,
} from '@/lib/authorizedHandler.server';
import {
  ApiAuthError,
  resolveAuth,
  requireScope,
  assertUserHasSiteAccess,
} from '@/lib/apiAuth.server';

const resolveAuthMock = resolveAuth as unknown as jest.Mock;
const requireScopeMock = requireScope as unknown as jest.Mock;
const assertUserHasSiteAccessMock = assertUserHasSiteAccess as unknown as jest.Mock;

beforeEach(() => {
  setCalls.length = 0;
  setShouldReject = null;
  warnSpy.mockClear();
  errorSpy.mockClear();
  resolveAuthMock.mockClear();
  requireScopeMock.mockClear();
  assertUserHasSiteAccessMock.mockClear();
  checkRateLimitSpy.mockClear();
  securityConfigReadSpy.mockClear();
  resolveAuthResult = { userId: 'uid_alice', keyContext: null };
  resolveAuthThrows = null;
  rateLimitResult = { ok: true };
  configResult = {
    capability_enforcement: true,
    rate_limit_enforcement: true,
    lastUpdated: 0,
    expiresAt: 0,
  };
  userDoc = { exists: true, data: () => ({ role: 'admin', sites: ['site-a'] }) };
  siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };
  requireScopeMock.mockReturnValue({ isLegacy: false });
  assertUserHasSiteAccessMock.mockResolvedValue({ siteId: 'site-a', siteData: {} });
});

function makeRequest(url = 'http://localhost/api/sites/site-a/test', method = 'POST'): NextRequest {
  // NextRequest from "next/server" requires a fully-formed Request; the
  // wrapper only inspects nextUrl + headers + method, so a stub Request works.
  // We wrap in NextRequest's class via the helper from next/server.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest: NR } = require('next/server');
  return new NR(url, { method });
}

function pathParamsFor(siteId: string): { params: Promise<{ siteId: string }> } {
  return { params: Promise.resolve({ siteId }) };
}

/* -------------------------------------------------------------------------- */
/*  authorizedSiteHandler                                                     */
/* -------------------------------------------------------------------------- */

type SiteHandler = Parameters<ReturnType<typeof authorizedSiteHandler>>[0];
type PlatformHandler = Parameters<ReturnType<typeof authorizedPlatformHandler>>[0];

function makeSiteHandler(impl: (...args: Parameters<SiteHandler>) => ReturnType<SiteHandler>): jest.MockedFunction<SiteHandler> {
  return jest.fn(impl) as unknown as jest.MockedFunction<SiteHandler>;
}

function makePlatformHandler(impl: (...args: Parameters<PlatformHandler>) => ReturnType<PlatformHandler>): jest.MockedFunction<PlatformHandler> {
  return jest.fn(impl) as unknown as jest.MockedFunction<PlatformHandler>;
}

describe('authorizedSiteHandler — happy path', () => {
  it('invokes handler with actor + siteId + correlationId', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = handler.mock.calls[0][1];
    expect(ctx.actor).toEqual({ type: 'user', userId: 'uid_alice', role: 'admin', sites: ['site-a'] });
    expect(ctx.siteId).toBe('site-a');
    expect(typeof ctx.correlationId).toBe('string');
    expect(ctx.correlationId).toMatch(/^[0-9a-f]{22}$/);
  });

  it('writes a blocking allow audit before invoking the handler', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    await wrapped(makeRequest(), pathParamsFor('site-a'));
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow!.path.startsWith('sites/site-a/audit_log/')).toBe(true);
    expect(allow!.payload.capability).toBe('MACHINE_EXEC_COMMAND');
  });

  it('reads siteId from query when configured', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'query' })(handler);

    await wrapped(makeRequest('http://localhost/api/x?siteId=site-a'), { params: Promise.resolve({}) });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].siteId).toBe('site-a');
  });

});

describe('authorizedSiteHandler — allow-audit fail-closed', () => {
  it('returns 503 and does not invoke the handler when the allow audit fails', async () => {
    setShouldReject = new Error('audit firestore down');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('authorizedSiteHandler — kill switches', () => {
  it('capability kill switch off: bypasses cap check and stamps metadata.enforcement_bypassed=capability', async () => {
    configResult = { ...configResult, capability_enforcement: false };
    // With capability_enforcement off, even a member should pass the cap check.
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    const meta = allow!.payload.metadata as Record<string, unknown>;
    expect(meta.enforcement_bypassed).toBe('capability');
    expect(allow!.payload.enforcementBypassed).toBe(true);
  });

  it('rate-limit kill switch off: bypasses rate-limit check and stamps metadata.enforcement_bypassed=rate_limit', async () => {
    configResult = { ...configResult, rate_limit_enforcement: false };
    rateLimitResult = { ok: false, reason: 'rate_limited', retryAfterSec: 30 }; // would otherwise reject
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    expect(checkRateLimitSpy).not.toHaveBeenCalled();
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    const meta = allow!.payload.metadata as Record<string, unknown>;
    expect(meta.enforcement_bypassed).toBe('rate_limit');
    expect(allow!.payload.enforcementBypassed).toBe(true);
  });

  it('api-key scope check is NEVER bypassed (both kill switches off + read-only key still rejected)', async () => {
    configResult = { capability_enforcement: false, rate_limit_enforcement: false, lastUpdated: 0, expiresAt: 0 };
    requireScopeMock.mockImplementation(() => {
      throw new ApiAuthError(403, 'insufficient scope: requires write on site:site-a', {
        code: 'scope_insufficient',
        details: { resource: 'site', id: 'site-a', permission: 'write' },
      });
    });
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // a deny audit should be written
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect(deny).toBeDefined();
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('scope_insufficient');
  });
});

describe('authorizedSiteHandler — denials', () => {
  it('returns 404 when site access fails (collapsed from 403/404)', async () => {
    assertUserHasSiteAccessMock.mockRejectedValue(new ApiAuthError(403, 'no access'));
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 + deny audit when the capability is missing', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('capability_missing');
  });

  it('returns 429 + deny audit when rate limited', async () => {
    rateLimitResult = { ok: false, reason: 'rate_limited', retryAfterSec: 12 };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('rate_limited');
  });

  it('returns 401 when auth resolution throws unauthorized', async () => {
    resolveAuthThrows = { status: 401, message: 'no session' };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when siteId is missing from path', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('authorizedSiteHandler — handler error path', () => {
  it('writes an error audit and re-throws', async () => {
    const handler = makeSiteHandler(async () => {
      throw new Error('boom');
    });
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    await expect(wrapped(makeRequest(), pathParamsFor('site-a'))).rejects.toThrow('boom');
    // wait for fire-and-forget error audit to land
    await new Promise((r) => setImmediate(r));
    const errorEntry = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'error');
    expect(errorEntry).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  authorizedPlatformHandler                                                 */
/* -------------------------------------------------------------------------- */

describe('authorizedPlatformHandler', () => {
  beforeEach(() => {
    userDoc = { exists: true, data: () => ({ role: 'superadmin', sites: [] }) };
  });

  it('superadmin succeeds and audits to global path', async () => {
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow!.path.startsWith('global/audit_log/entries/')).toBe(true);
  });

  it('non-superadmin rejected with 403 + deny audit', async () => {
    userDoc = { exists: true, data: () => ({ role: 'admin', sites: [] }) };
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // deny audit landed asynchronously
    await new Promise((r) => setImmediate(r));
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect(deny).toBeDefined();
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('role_insufficient');
  });

  it('returns 503 when allow audit write fails', async () => {
    setShouldReject = new Error('audit firestore down');
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);
    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  typescript: siteIdParam: 'body' must be a build error                     */
/* -------------------------------------------------------------------------- */

describe('typescript: siteIdParam type-system rejection', () => {
  it('only "path" and "query" are valid SiteIdSource values', () => {
    const valid: SiteIdSource[] = ['path', 'query'];
    expect(valid).toEqual(['path', 'query']);

    // The next line is intentionally a type-error to confirm `'body'` is
    // rejected at compile time. ts-expect-error fails if the line is NOT
    // actually an error (i.e. if someone widens the type to `string`).
    // @ts-expect-error -- 'body' is not assignable to SiteIdSource
    const invalid: SiteIdSource = 'body';
    expect(invalid).toBe('body'); // runtime is unchanged; compile-time is the gate
  });
});
