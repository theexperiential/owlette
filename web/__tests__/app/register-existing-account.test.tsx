/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /register when the person already has an account.
 *
 * Google OAuth signs up and signs in through one popup, so a returning user is
 * simply logged in. The page used to claim "account created with Google!" and
 * push /dashboard before the session cookie existed, so the proxy bounced them
 * to /login and it read as a silent failure.
 *
 * The email path can't log anyone in (no password), so it must say so inline
 * and offer somewhere to go.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { InAppBrowserState } from '@/hooks/useInAppBrowser';

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Not in an in-app browser, so the Google button stays rendered.
const inAppState: InAppBrowserState = { isInApp: false, escapeAttempted: false };
jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => inAppState,
}));

const signInWithGoogle = jest.fn();
const signUp = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signUp, signInWithGoogle }),
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn() }),
}));

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: jest.fn(),
  },
}));

const resolvePostSignInPath = jest.fn();
jest.mock('@/lib/postSignIn', () => ({
  resolvePostSignInPath: (...args: unknown[]) => resolvePostSignInPath(...args),
}));

import RegisterPage from '@/app/register/page';

describe('/register google path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolvePostSignInPath.mockResolvedValue('/dashboard');
  });

  it('does not claim an account was created for a returning user', async () => {
    signInWithGoogle.mockResolvedValue({ isNewUser: false });
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/welcome back/i),
    );
    expect(toastSuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/account created/i),
    );
  });

  it('still congratulates a genuinely new account', async () => {
    signInWithGoogle.mockResolvedValue({ isNewUser: true });
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/account created with Google/i),
      ),
    );
  });

  // The regression: pushing /dashboard immediately raced the session cookie and
  // the proxy bounced the user to /login.
  it('resolves the landing instead of pushing /dashboard blind', async () => {
    signInWithGoogle.mockResolvedValue({ isNewUser: false });
    resolvePostSignInPath.mockResolvedValue('/verify-2fa?redirect=%2Fdashboard');
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(resolvePostSignInPath).toHaveBeenCalledWith('/dashboard');
    expect(push).toHaveBeenCalledWith('/verify-2fa?redirect=%2Fdashboard');
  });
});

describe('/register email path with an existing account', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolvePostSignInPath.mockResolvedValue('/dashboard');
  });

  const fillAndSubmit = async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);

    // Focus reveals the rest of the form (progressive disclosure).
    await user.click(screen.getByLabelText(/^email$/i));
    await user.type(screen.getByLabelText(/^email$/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'Sup3rSecret!');
    await user.type(screen.getByLabelText(/^confirm password$/i), 'Sup3rSecret!');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /^create account$/i }));
  };

  it('explains inline and offers a route to sign in', async () => {
    signUp.mockRejectedValue({ code: 'auth/email-already-in-use' });

    await fillAndSubmit();

    const notice = await screen.findByTestId('register-existing-account');
    expect(notice).toHaveTextContent(/an account with this email already exists/i);
    expect(screen.getByRole('link', { name: /sign in instead/i })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.getByRole('link', { name: /reset your password/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('does not also fire a toast that expires with no next step', async () => {
    signUp.mockRejectedValue({ code: 'auth/email-already-in-use' });

    await fillAndSubmit();

    await screen.findByTestId('register-existing-account');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still toasts for unrelated signup failures', async () => {
    signUp.mockRejectedValue({ code: 'auth/too-many-requests' });

    await fillAndSubmit();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByTestId('register-existing-account')).not.toBeInTheDocument();
  });
});
