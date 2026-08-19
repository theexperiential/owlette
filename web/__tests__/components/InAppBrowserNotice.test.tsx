/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The notice renders on two different triggers and must not give the same
 * advice to both.
 *
 * Inside a host app (detected up front) the user genuinely can escape, so the
 * "open in safari" shortcut and the manual ••• instructions are the point.
 *
 * On the reactive path — auth/popup-blocked in an ordinary browser with a popup
 * blocker — there is nowhere to escape TO. The escape would resolve to a
 * same-URL reload, and since `popupBlocked` is plain component state that
 * reload would drop the notice and hand the user back to the button that just
 * failed. So the escape affordances are suppressed there and the remediation is
 * the email form, copy-link, and try-anyway.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import { InAppBrowserNotice } from '@/components/InAppBrowserNotice';

describe('InAppBrowserNotice inside a detected host app', () => {
  it('names the host app and offers the escape affordances', () => {
    render(<InAppBrowserNotice isInApp appName="LinkedIn" />);

    expect(screen.getByTestId('inapp-browser-notice')).toHaveTextContent(
      /google sign-in doesn't work in the LinkedIn browser/i,
    );
    expect(screen.getByTestId('inapp-open-browser')).toBeInTheDocument();
    expect(screen.getByTestId('inapp-copy-link')).toBeInTheDocument();
  });

  it('falls back to generic wording when the host app is unidentified', () => {
    render(<InAppBrowserNotice isInApp />);

    expect(screen.getByTestId('inapp-browser-notice')).toHaveTextContent(
      /doesn't work in this in-app browser/i,
    );
  });
});

describe('InAppBrowserNotice on the popup-blocked path', () => {
  it('does not offer an escape there is nowhere to make', () => {
    render(<InAppBrowserNotice isInApp={false} />);

    expect(screen.queryByTestId('inapp-open-browser')).not.toBeInTheDocument();
    // "tap the ••• menu at the top of this window" is nonsense in desktop Chrome.
    expect(screen.getByTestId('inapp-browser-notice')).not.toHaveTextContent(/•••/);
  });

  it('still explains what happened and keeps copy-link', () => {
    render(<InAppBrowserNotice isInApp={false} />);

    expect(screen.getByTestId('inapp-browser-notice')).toHaveTextContent(
      /your browser blocked the google sign-in window/i,
    );
    expect(screen.getByTestId('inapp-copy-link')).toBeInTheDocument();
  });
});

describe('InAppBrowserNotice try-anyway escape hatch', () => {
  it('is rendered only when a handler is supplied', () => {
    const { rerender } = render(<InAppBrowserNotice isInApp />);
    expect(screen.queryByTestId('inapp-try-google-anyway')).not.toBeInTheDocument();

    rerender(<InAppBrowserNotice isInApp onTryAnyway={jest.fn()} />);
    expect(screen.getByTestId('inapp-try-google-anyway')).toBeInTheDocument();
  });
});
