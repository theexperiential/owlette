/** @jest-environment node */

/**
 * Tests for the security-version response header attached by the
 * Next.js proxy (the "middleware" in Next.js 16+ parlance).
 *
 * !! THIS IS UX, NOT SAFETY !! — see `lib/securityVersion.ts`.
 */

import { NextRequest } from 'next/server';

const mockValidateSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  validateSessionFromRequest: (...args: unknown[]) => mockValidateSession(...args),
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
  });

  it('attaches x-security-version on /api/* responses', async () => {
    const response = await proxy(makeRequest('/api/sites'));
    expect(response.headers.get(SECURITY_VERSION_HEADER)).toBe(
      String(CURRENT_SECURITY_VERSION),
    );
  });

  it('attaches x-security-version on nested /api/* paths', async () => {
    const response = await proxy(makeRequest('/api/admin/installer/upload'));
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
