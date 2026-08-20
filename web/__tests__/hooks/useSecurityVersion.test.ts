/**
 * @jest-environment jsdom
 *
 * `useSecurityVersion` — the fetch interceptor that flips a global flag when the
 * server's `x-security-version` differs from the bundle's compiled-in value.
 *
 * !! THIS IS UX, NOT SAFETY !! — see `lib/securityVersion.ts`.
 */

import { act, renderHook } from '@testing-library/react';
import {
  useSecurityVersion,
  __resetSecurityVersionForTests,
} from '@/hooks/useSecurityVersion';
import {
  CURRENT_SECURITY_VERSION,
  SECURITY_VERSION_HEADER,
} from '@/lib/securityVersion';

describe('useSecurityVersion', () => {
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    __resetSecurityVersionForTests();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  // jsdom has no global `Response`, but the hook only reads
  // `response.headers.get(...)`, so this stub avoids a fetch polyfill.
  function fakeResponse(headers: Record<string, string>): Response {
    return { headers: new Headers(headers) } as unknown as Response;
  }

  function makeFetchReturning(headers: Record<string, string>) {
    return jest.fn(async () => fakeResponse(headers));
  }

  it('returns false on initial mount when no fetch has happened', () => {
    window.fetch = makeFetchReturning({});
    const { result } = renderHook(() => useSecurityVersion());
    expect(result.current).toBe(false);
  });

  it('stays false when server reports the matching version', async () => {
    window.fetch = makeFetchReturning({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION),
    });
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/api/test');
    });
    expect(result.current).toBe(false);
  });

  it('flips to true when the server reports a newer version', async () => {
    window.fetch = makeFetchReturning({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION + 1),
    });
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/api/test');
    });
    expect(result.current).toBe(true);
  });

  it('flips to true when the server reports an older version', async () => {
    window.fetch = makeFetchReturning({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION - 1),
    });
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/api/test');
    });
    expect(result.current).toBe(true);
  });

  it('ignores responses without the header', async () => {
    window.fetch = makeFetchReturning({});
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/some/non-api/path');
    });
    expect(result.current).toBe(false);
  });

  it('latches once mismatched — a later matching response cannot clear it', async () => {
    const fetchMock = jest.fn(async (url: unknown) => {
      const path = String(url);
      if (path.includes('mismatch')) {
        return fakeResponse({
          [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION + 1),
        });
      }
      return fakeResponse({
        [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION),
      });
    });
    window.fetch = fetchMock as unknown as typeof window.fetch;
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/api/mismatch');
    });
    expect(result.current).toBe(true);
    await act(async () => {
      await window.fetch('/api/match');
    });
    expect(result.current).toBe(true);
  });

  it('ignores non-numeric header values', async () => {
    window.fetch = makeFetchReturning({
      [SECURITY_VERSION_HEADER]: 'not-a-number',
    });
    const { result } = renderHook(() => useSecurityVersion());
    await act(async () => {
      await window.fetch('/api/test');
    });
    expect(result.current).toBe(false);
  });
});
