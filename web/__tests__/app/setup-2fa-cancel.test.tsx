/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Bailing out of /setup-2fa.
 *
 * OWLETTE-WEB-46: "cancel" was `router.back()`, and for a brand-new signup the previous
 * history entry is /register — a real user landed back on the signup form they had just
 * submitted, re-filled it, and hit auth/email-already-in-use with nowhere to go. So:
 * never `back()`. Where cancel leads depends on whether setup is mandatory here;
 * /dashboard would bounce a `requiresMfaSetup` user straight back (dashboard/page.tsx's
 * 2FA guard) — a loop, not an exit.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const signOut = jest.fn();
let requiresMfaSetup = true;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1', email: 'new@example.com' },
    loading: false,
    requiresMfaSetup,
    signOut,
  }),
}));

const push = jest.fn();
const replace = jest.fn();
const back = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back, prefetch: jest.fn() }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// jsdom has no WebAuthn, so `browserSupportsWebAuthn` would hide the passkey option and
// the chooser would half-render. Stub the module; no ceremony is started in these tests.
jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: jest.fn(),
  startAuthentication: jest.fn(),
}));

import Setup2FAPage from '@/app/setup-2fa/page';

const renderPage = async () => {
  const user = userEvent.setup();
  render(<Setup2FAPage />);
  // The method chooser is the landing step; wait for it so the click below
  // isn't racing the post-hydration WebAuthn-support check.
  await screen.findByText(/choose your second factor/i);
  return user;
};

beforeEach(() => {
  jest.clearAllMocks();
  requiresMfaSetup = true;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ secret: 'ABC123', qrCodeUrl: 'data:image/png;base64,x' }),
  }) as unknown as typeof fetch;
});

describe('/setup-2fa cancel when 2FA setup is mandatory', () => {
  it('never walks the user back into the signup form', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalledWith('/register');
    expect(replace).not.toHaveBeenCalledWith('/register');
  });

  it('ends the session rather than looping through /dashboard', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('says "sign out", because that is what it does', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('keeps a still-signed-in user put when sign-out fails', async () => {
    signOut.mockRejectedValue(new Error('network'));
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('/setup-2fa cancel when enrolling voluntarily', () => {
  beforeEach(() => {
    requiresMfaSetup = false;
  });

  it('returns to the dashboard without signing anyone out', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(signOut).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });
});

/**
 * The chooser itself. A beta tester with no phone couldn't finish signup while this page
 * was a QR code and nothing else, so pin that the phone-free option is offered FIRST and
 * that the authenticator option says out loud that a desktop app will do.
 */
describe('/setup-2fa method chooser', () => {
  it('offers the passkey first and marks it recommended', async () => {
    await renderPage();

    const passkey = screen.getByRole('button', { name: /passkey/i });
    const authenticator = screen.getByRole('button', { name: /authenticator app/i });

    expect(passkey).toHaveTextContent(/recommended/i);
    expect(passkey).toHaveTextContent(/windows hello/i);
    expect(passkey).toHaveTextContent(/security key/i);
    // DOCUMENT_POSITION_FOLLOWING — the passkey card precedes the TOTP one.
    expect(passkey.compareDocumentPosition(authenticator) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('tells people an authenticator app can live on their desktop', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: /authenticator app/i }))
      .toHaveTextContent(/phone or desktop/i);
  });

  it('does not mint a TOTP secret until the authenticator branch is chosen', async () => {
    const user = await renderPage();

    expect(global.fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /authenticator app/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/mfa/setup', expect.anything())
    );
  });
});
