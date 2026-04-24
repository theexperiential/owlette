/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';
import {
  CURRENT_ROOST_VERSION,
  SUPPORTED_ROOST_VERSIONS,
} from '@/app/api/version/route';
import {
  ROOST_VERSION_HEADER,
  ROOST_VERSION_MISSING_HEADER,
  applyVersionHeaders,
  checkRoostVersion,
} from '@/lib/versionHeader';

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest(new URL('http://localhost/api/test'), { headers });
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkRoostVersion', () => {
  it('passes silently when the current version is pinned', () => {
    const result = checkRoostVersion(makeReq({ [ROOST_VERSION_HEADER]: CURRENT_ROOST_VERSION }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missing).toBe(false);
      expect(result.effectiveVersion).toBe(CURRENT_ROOST_VERSION);
    }
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('passes with missing=true + logs when header omitted', () => {
    const result = checkRoostVersion(makeReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missing).toBe(true);
      expect(result.effectiveVersion).toBe(CURRENT_ROOST_VERSION);
    }
    expect(console.warn).toHaveBeenCalled();
  });

  it('passes with missing=true when header is whitespace-only', () => {
    const result = checkRoostVersion(makeReq({ [ROOST_VERSION_HEADER]: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.missing).toBe(true);
  });

  it('returns 400 problem+json with code unsupported_version for bad version', async () => {
    const result = checkRoostVersion(makeReq({ [ROOST_VERSION_HEADER]: '1999-01-01' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.code).toBe('unsupported_version');
      expect(body.sent).toBe('1999-01-01');
      expect(body.supported).toEqual(SUPPORTED_ROOST_VERSIONS);
    }
  });

  it('case-insensitive lookup: roost-version header also accepted', () => {
    const result = checkRoostVersion(makeReq({ 'roost-version': CURRENT_ROOST_VERSION }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.missing).toBe(false);
  });
});

describe('applyVersionHeaders', () => {
  it('adds X-Roost-Version-Missing: true when missing', () => {
    const response = NextResponse.json({ ok: true });
    applyVersionHeaders(response, {
      ok: true,
      missing: true,
      effectiveVersion: CURRENT_ROOST_VERSION,
    });
    expect(response.headers.get(ROOST_VERSION_MISSING_HEADER)).toBe('true');
  });

  it('is a no-op when caller pinned', () => {
    const response = NextResponse.json({ ok: true });
    applyVersionHeaders(response, {
      ok: true,
      missing: false,
      effectiveVersion: CURRENT_ROOST_VERSION,
    });
    expect(response.headers.get(ROOST_VERSION_MISSING_HEADER)).toBeNull();
  });
});
