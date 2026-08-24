/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SecurityVersionBanner is non-dismissible by design — only a real
 * `window.location.reload()` (new bundle, reset module state) clears it. These
 * pin both halves: it shows when stale, and no close affordance exists.
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

  // jsdom has no global `Response`; the hook only reads `headers.get(...)`, so
  // a plain object with a real `Headers` is enough — no polyfill needed.
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
    // No close affordance under any common a11y name.
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

    // Does NOT clear on click — only a real reload resets module state.
    expect(
      screen.getByText('a security update is available. reload to continue.'),
    ).toBeInTheDocument();
  });
});
