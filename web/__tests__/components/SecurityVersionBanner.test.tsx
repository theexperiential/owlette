/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Tests for SecurityVersionBanner. The banner is non-dismissible by
 * design — the only way to clear it is a real `window.location.reload()`,
 * which fetches the new bundle and resets module-level state. These
 * tests pin both halves of that contract: it shows when stale, and
 * there's no close affordance.
 *
 * !! THIS IS UX, NOT SAFETY !! — see `lib/securityVersion.ts`.
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityVersionBanner } from '@/components/SecurityVersionBanner';
import { __resetSecurityVersionForTests } from '@/hooks/useSecurityVersion';
import {
  CURRENT_SECURITY_VERSION,
  SECURITY_VERSION_HEADER,
} from '@/lib/securityVersion';

describe('SecurityVersionBanner', () => {
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    __resetSecurityVersionForTests();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  // jsdom does not expose a global `Response` constructor; the hook only
  // reads `response.headers.get(...)`, so a plain object with a real
  // `Headers` instance satisfies the surface without pulling in a polyfill.
  function fakeResponse(headers: Record<string, string>): Response {
    return { headers: new Headers(headers) } as unknown as Response;
  }

  it('renders nothing when the security version matches', () => {
    window.fetch = jest.fn(async () => fakeResponse({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION),
    }));
    const { container } = render(<SecurityVersionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the lowercase reload prompt once a mismatch is detected', async () => {
    window.fetch = jest.fn(async () => fakeResponse({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION + 1),
    }));
    render(<SecurityVersionBanner />);
    await act(async () => {
      await window.fetch('/api/test');
    });
    expect(
      screen.getByText('a security update is available. reload to continue.'),
    ).toBeInTheDocument();
  });

  it('exposes only a reload action — no close/dismiss button exists', async () => {
    window.fetch = jest.fn(async () => fakeResponse({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION + 1),
    }));
    render(<SecurityVersionBanner />);
    await act(async () => {
      await window.fetch('/api/test');
    });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('reload');
    // No close affordance under any of the common a11y names.
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByLabelText(/close/i)).toBeNull();
    expect(screen.queryByLabelText(/dismiss/i)).toBeNull();
  });

  it('clicking the reload button calls window.location.reload — no soft-dismiss path', async () => {
    window.fetch = jest.fn(async () => fakeResponse({
      [SECURITY_VERSION_HEADER]: String(CURRENT_SECURITY_VERSION + 1),
    }));
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });

    const user = userEvent.setup();
    render(<SecurityVersionBanner />);
    await act(async () => {
      await window.fetch('/api/test');
    });
    await user.click(screen.getByRole('button', { name: /reload/i }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Banner does NOT clear after the click — only a true page reload
    // (which resets module state) can clear it.
    expect(
      screen.getByText('a security update is available. reload to continue.'),
    ).toBeInTheDocument();
  });
});
