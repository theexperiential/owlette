/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /register and /login when the visitor is already signed in.
 *
 * proxy.ts has this rule, but it only sees requests that reach the server. A
 * client-side history pop replays the page out of the App Router cache with no
 * round trip — which is how the OWLETTE-WEB-46 user, having cancelled out of
 * /setup-2fa, ended up re-submitting a signup form while authenticated.
 *
 * The interesting case is the second one in each block: the guard must not fire
 * during a sign-in THIS page is performing, or it would beat the handler's own
 * navigation and send a brand-new signup to /dashboard instead of /setup-2fa.
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

const inAppState: InAppBrowserState = { isInApp: false, escapeAttempted: false };
jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => inAppState,
}));

const signUp = jest.fn();
const signIn = jest.fn();
const signInWithGoogle = jest.fn();
let authUser: { uid: string } | null = null;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: authUser,
    loading: false,
    signUp,
    signIn,
    signInWithGoogle,
  }),
}));

const push = jest.fn();
const replace = jest.fn();
let search = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const resolvePostSignInPath = jest.fn();
jest.mock('@/lib/postSignIn', () => ({
  resolvePostSignInPath: (...args: unknown[]) => resolvePostSignInPath(...args),
}));

import RegisterPage from '@/app/register/page';
import LoginPage from '@/app/login/page';

beforeEach(() => {
  jest.clearAllMocks();
  authUser = null;
  search = '';
  resolvePostSignInPath.mockResolvedValue('/setup-2fa');
});

describe('/register', () => {
  it('bounces a signed-in visitor off the signup form', async () => {
    authUser = { uid: 'already-registered' };

    render(<RegisterPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('leaves the form alone for a visitor who is not signed in', async () => {
    render(<RegisterPage />);

    // The email field is the progressive-disclosure trigger, so it is the one
    // control on screen before anything is expanded.
    await screen.findByLabelText(/^email$/i);
    expect(replace).not.toHaveBeenCalled();
  });

  // The regression this guard could easily have introduced: signUp() populates
  // `user` before the page has resolved where to send them.
  it('does not pre-empt the /setup-2fa push of a signup it is running itself', async () => {
    signUp.mockImplementation(async () => {
      authUser = { uid: 'brand-new' };
    });
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.click(screen.getByLabelText(/^email$/i));
    await user.type(screen.getByLabelText(/^email$/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'Sup3rSecret!');
    await user.type(screen.getByLabelText(/^confirm password$/i), 'Sup3rSecret!');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /^create account$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/setup-2fa'));
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('/login', () => {
  it('bounces a signed-in visitor off the login form', async () => {
    authUser = { uid: 'already-signed-in' };

    render(<LoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  // The proxy bounces an unauthenticated request to /login?redirect=<path>. If
  // the session cookie lands a moment later, this page is where the user is
  // sitting — and sending them to /dashboard would silently drop the path they
  // actually asked for.
  it('honours the redirect param rather than the default landing', async () => {
    authUser = { uid: 'already-signed-in' };
    search = 'redirect=%2Froost';

    render(<LoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/roost'));
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('ignores a protocol-relative redirect that would leave the site', async () => {
    authUser = { uid: 'already-signed-in' };
    search = 'redirect=%2F%2Fevil.example';

    render(<LoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('does not pre-empt a sign-in it is running itself', async () => {
    resolvePostSignInPath.mockResolvedValue('/verify-2fa?redirect=%2Fdashboard');
    signIn.mockImplementation(async () => {
      authUser = { uid: 'signing-in' };
    });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByLabelText(/^email$/i));
    await user.type(screen.getByLabelText(/^email$/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'Sup3rSecret!');
    await user.click(screen.getByRole('button', { name: /^sign in with email$/i }));

    // The handler's own destination wins — the guard would have sent them to
    // /dashboard and skipped the MFA challenge entirely.
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/verify-2fa?redirect=%2Fdashboard'),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
