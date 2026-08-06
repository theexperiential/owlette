/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The in-app-browser branch of /register.
 *
 * Inside a third-party webview, "continue with Google" cannot work — the popup
 * is refused by the host app and no Firebase configuration changes that (see
 * lib/inAppBrowser). This asserts the pre-empt: the button is swapped for
 * remediation that names the host app, and the email fallback we point the user
 * at is expanded rather than left collapsed behind a focus gesture.
 *
 * The negative case is asserted just as hard. Detection gates a working sign-in
 * path, so an ordinary visitor must see exactly what they saw before.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import type { InAppBrowserState } from '@/hooks/useInAppBrowser';

// jsdom ships no ResizeObserver, and the expanded email form renders Radix
// primitives (the terms checkbox) that construct one on mount. Local rather
// than in jest.setup.js: this is the first suite to render that subtree, so
// there is no shared need to serve yet.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let inAppState: InAppBrowserState = { isInApp: false, escapeAttempted: false };

jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => inAppState,
}));

const signInWithGoogle = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ signUp: jest.fn(), signInWithGoogle }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

import RegisterPage from '@/app/register/page';

describe('/register outside an in-app browser', () => {
  beforeEach(() => {
    inAppState = { isInApp: false, escapeAttempted: false };
  });

  it('renders the Google button and no remediation notice', () => {
    render(<RegisterPage />);

    expect(
      screen.getByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('inapp-browser-notice')).not.toBeInTheDocument();
  });

  it('leaves the email form collapsed behind its focus reveal', () => {
    render(<RegisterPage />);

    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });
});

describe('/register inside an in-app browser', () => {
  beforeEach(() => {
    inAppState = {
      isInApp: true,
      appKey: 'linkedin',
      appName: 'LinkedIn',
      escapeAttempted: false,
    };
  });

  it('replaces the Google button with remediation naming the host app', () => {
    render(<RegisterPage />);

    expect(
      screen.queryByRole('button', { name: /continue with google/i }),
    ).not.toBeInTheDocument();

    const notice = screen.getByTestId('inapp-browser-notice');
    expect(notice).toHaveTextContent(/google sign-in doesn't work in the LinkedIn browser/i);
    expect(screen.getByTestId('inapp-open-browser')).toBeInTheDocument();
    expect(screen.getByTestId('inapp-copy-link')).toBeInTheDocument();
  });

  it('expands the email fallback it points the user at', () => {
    render(<RegisterPage />);

    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^confirm password$/i)).toBeInTheDocument();
  });

  // Fail open. Detection is a heuristic over user-agent strings; it must never
  // be the only thing standing between a user and a sign-in method.
  it('still offers a way to attempt Google anyway', () => {
    render(<RegisterPage />);

    expect(screen.getByTestId('inapp-try-google-anyway')).toBeInTheDocument();
  });

  it('escalates to manual instructions once the one-tap escape has been tried', () => {
    inAppState = { ...inAppState, escapeAttempted: true };
    render(<RegisterPage />);

    expect(screen.getByTestId('inapp-browser-notice')).toHaveTextContent(
      /the shortcut didn't work in this app/i,
    );
  });
});
