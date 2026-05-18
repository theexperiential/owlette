/** @jest-environment node */

/**
 * Tests for the security-version response header attached by the
 * Next.js proxy (the "middleware" in Next.js 16+ parlance).
 *
 * !! THIS IS UX, NOT SAFETY !! — see `lib/securityVersion.ts`.
 */

import { NextRequest } from 'next/server';

const mockValidateSession = jest.fn();
const mockEvaluateSessionMfa = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  validateSessionFromRequest: (...args: unknown[]) => mockValidateSession(...args),
  evaluateSessionMfa: (...args: unknown[]) => mockEvaluateSessionMfa(...args),
}));

import { proxy } from '@/proxy';
import {
  CURRENT_SECURITY_VERSION,
  SECURITY_VERSION_HEADER,
} from '@/lib/securityVersion';

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${pathname}`));
}

describe('proxy — x-security-version header', () => {
  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    // Default to "no session" so the page-route test below redirects
    // to /login rather than landing in the protected-path branch.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
  });

  it('attaches x-security-version on /api/* responses', async () => {
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('attaches x-security-version on nested /api/* paths', async () => {
    const response = await proxy(makeRequest('/api/installer/upload'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('does not skip header even on unauthenticated /api/* calls', async () => {
    mockValidateSession.mockResolvedValue(null);
    const response = await proxy(makeRequest('/api/agent/heartbeat'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('emits header value as a numeric string (not object/JSON)', async () => {
    const response = await proxy(makeRequest('/api/test'));
    const value = response.headers.get(SECURITY_VERSION_HEADER);
    expect(value).not.toBeNull();
    expect(Number.isFinite(Number.parseInt(value as string, 10))).toBe(true);
  });

  it('does not attach the header on non-api routes (page routes)', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    // Page routes either redirect (unauthenticated) or pass through; in
    // both cases the header is not relevant and must not be stamped.
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBeNull();
  });

  it('still redirects legacy /api/folders before stamping the header', async () => {
    const response = await proxy(makeRequest('/api/folders/abc'));
    expect(response.status).toBe(308);
    // Redirect responses bypass the header — that's fine, the client
    // follows the 308 and reads the header from the resolved /api/roosts
    // response.
    expect(response.headers.get('location')).toContain('/api/roosts/abc');
  });
});

describe('proxy — MFA gate', () => {
  beforeEach(() => {
    mockValidateSession.mockResolvedValue(null);
    mockEvaluateSessionMfa.mockReset();
  });

  it('redirects unauthenticated requests on protected paths to /login', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('redirects authenticated-but-MFA-pending requests to /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location');
    expect(loc).toContain('/verify-2fa');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('lets MFA-verified sessions through to protected paths', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/dashboard'));
    // pass = NextResponse.next(); no redirect, no Location header.
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows /verify-2fa for authenticated-but-pending sessions (so the challenge can be completed)', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects unauthenticated /verify-2fa requests to /login', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('redirects already-verified sessions away from /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa'));
    expect(response.status).toBe(307);
    // Default redirect is /dashboard when no safe redirect param is set.
    expect(response.headers.get('location')).toContain('/dashboard');
  });

  it('preserves redirect param when bouncing already-verified users off /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/verify-2fa?redirect=%2Fadmin'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/admin');
  });

  it('rejects open-redirect attempts in /verify-2fa redirect param', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    // `//evil.example.com` is a protocol-relative URL → not safe.
    const response = await proxy(
      makeRequest('/verify-2fa?redirect=%2F%2Fevil.example.com')
    );
    expect(response.headers.get('location')).toContain('/dashboard');
    expect(response.headers.get('location')).not.toContain('evil.example.com');
  });

  it('bounces MFA-pending users off /login to /verify-2fa', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/login'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/verify-2fa');
  });

  it('bounces MFA-verified users off /login to /dashboard', async () => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/login'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/dashboard');
  });

  // ----------- Item 8 additional coverage -----------

  it('preserves the redirect param when bouncing MFA-pending users off /dashboard', async () => {
    // The challenge redirect should carry the originally-requested
    // protected path so the user lands back on it after verification.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'challenge',
      userId: 'user-1',
    });
    const response = await proxy(makeRequest('/admin/users'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('/verify-2fa');
    expect(loc).toContain('redirect=%2Fadmin%2Fusers');
  });

  it('fail-soft: when evaluateSessionMfa returns unauthenticated due to a downstream error, protected paths redirect to /login (not 500)', async () => {
    // Pre-Wave-2 sessions hit a one-time Firestore round-trip in
    // evaluateSessionMfa. Per its contract, if that read fails it returns
    // the unauthenticated outcome rather than throwing, so the proxy
    // continues to redirect (never 500s).
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'unauthenticated',
      userId: null,
    });
    const response = await proxy(makeRequest('/dashboard'));
    // The proxy should produce a 307 redirect, NEVER a 500.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('redirect-after-verify lands back on the original protected path on success', async () => {
    // After a successful TOTP submit, the user lands back on
    // /verify-2fa?redirect=<original>. If the session evaluates to `pass`
    // at that point, they should bounce to the original path, not the
    // default /dashboard.
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
    const response = await proxy(
      makeRequest('/verify-2fa?redirect=%2Fdeployments'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/deployments');
  });
});

/* -------------------------------------------------------------------- */
/*  Item 22: CSP header includes a per-request nonce                    */
/* -------------------------------------------------------------------- */

describe('proxy — CSP header', () => {
  beforeEach(() => {
    mockEvaluateSessionMfa.mockResolvedValue({
      outcome: 'pass',
      userId: 'user-1',
    });
  });

  it('attaches a Content-Security-Policy header on every response', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    expect(csp!.length).toBeGreaterThan(0);
  });

  it('script-src and style-src use the same per-request nonce', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    // Two nonce-* tokens with the same value (script-src + style-src).
    const matches = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const uniqueNonces = new Set(matches.map((m) => m.split('-')[1]));
    // The script-src + style-src + style-src-elem all share the same nonce.
    expect(uniqueNonces.size).toBe(1);
  });

  it('generates a fresh nonce on each request', async () => {
    const a = await proxy(makeRequest('/dashboard'));
    const b = await proxy(makeRequest('/dashboard'));
    const cspA = a.headers.get('Content-Security-Policy') ?? '';
    const cspB = b.headers.get('Content-Security-Policy') ?? '';
    const nonceA = (cspA.match(/'nonce-([A-Za-z0-9+/=]+)'/) ?? [])[1];
    const nonceB = (cspB.match(/'nonce-([A-Za-z0-9+/=]+)'/) ?? [])[1];
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
  });

  it('script-src does NOT allow unsafe-inline', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src '));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
  });

  it("script-src includes 'strict-dynamic' and a nonce", async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src ')) ?? '';
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it('frame-ancestors is locked to none (clickjacking)', async () => {
    const response = await proxy(makeRequest('/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('attaches CSP on /api/* responses too', async () => {
    mockValidateSession.mockResolvedValue(null);
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get('Content-Security-Policy')).not.toBeNull();
  });
});
