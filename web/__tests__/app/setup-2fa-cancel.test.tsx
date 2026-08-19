/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Bailing out of /setup-2fa.
 *
 * "cancel" used to be `router.back()`, and for a brand-new signup the previous
 * history entry is /register by construction. A real user (OWLETTE-WEB-46) got
 * dropped back onto the signup form they had just submitted, concluded the
 * account had not been created, filled it in again, and hit
 * auth/email-already-in-use with nowhere to go.
 *
 * So: never `back()`. Where cancel leads depends on whether 2FA setup is
 * mandatory here — /dashboard would bounce a `requiresMfaSetup` user straight
 * back (dashboard/page.tsx's 2FA guard), which is a loop, not an exit.
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

// The passkey enrolment panel is a separate concern with its own network calls.
jest.mock('@/components/PasskeyManager', () => ({
  PasskeyManager: () => null,
}));

import Setup2FAPage from '@/app/setup-2fa/page';

const renderPage = async () => {
  const user = userEvent.setup();
  render(<Setup2FAPage />);
  // The page POSTs /api/mfa/setup on mount; let that settle so the click below
  // isn't racing a state update.
  await screen.findByText(/step 1: scan QR code/i);
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
