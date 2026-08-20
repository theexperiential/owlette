'use client';

import { CopyIcon, ExternalLinkIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { toast } from '@/lib/toast';
import {
  copyToClipboard,
  escapeToSystemBrowser,
  systemBrowserLabel,
} from '@/lib/inAppBrowser';

/**
 * Explains why federated sign-in is unavailable and offers the only two fixes:
 * leave the webview, or sign in with the email form below.
 *
 * Inline rather than a toast (same reasoning as `ui/form-error`): a blocking
 * condition must persist until resolved, not expire in a corner.
 *
 * Two triggers, with adapted copy: pre-emptive when the host app is identified
 * before any tap, and reactive on `auth/popup-blocked` — which covers webviews
 * the UA doesn't identify plus ordinary popup-blocker / gesture-chain failures.
 */
export function InAppBrowserNotice({
  isInApp,
  appName,
  escapeAttempted = false,
  onTryAnyway,
  tryAnywayDisabled = false,
  className,
}: {
  /** True when the host app was identified; false on the popup-blocked path. */
  isInApp: boolean;
  /** Host app display name, when known. A proper noun — keep it cased. */
  appName?: string;
  /** The one-tap escape has already been tried and evidently did nothing. */
  escapeAttempted?: boolean;
  /** Fail open: allow the Google attempt regardless of detection. */
  onTryAnyway?: () => void;
  tryAnywayDisabled?: boolean;
  className?: string;
}) {
  const browser = systemBrowserLabel();
  const where = appName ? `the ${appName} browser` : 'this in-app browser';

  const headline = isInApp
    ? `google sign-in doesn't work in ${where}`
    : 'your browser blocked the google sign-in window';

  const body = isInApp
    ? `${appName ?? 'this app'} opens links in its own browser, which can't open the google sign-in window. use your email below, or open owlette.app in ${browser}.`
    : `use your email below, or open owlette.app in ${browser}.`;

  // The one-tap escape uses a private URL scheme many host apps ignore, and the
  // failure isn't detectable — so the manual route is always shown.
  const manualHint = escapeAttempted
    ? `still here? the shortcut didn't work in this app — tap the ••• menu at the top of this window and choose "open in ${browser}".`
    : 'if nothing happens, tap the ••• menu at the top of this window and choose "open in browser".';

  const handleOpen = () => {
    escapeToSystemBrowser();
  };

  const handleCopy = () => {
    // Not async on purpose: WebKit rejects the clipboard promise unless writeText
    // is reached synchronously from the user gesture.
    void copyToClipboard(window.location.href).then((ok) => {
      if (ok) {
        toast.success('link copied — paste it into your browser');
      } else {
        toast.error('could not copy the link');
      }
    });
  };

  return (
    <InlineNotice data-testid="inapp-browser-notice" className={className}>
      <>
        <div className="space-y-1">
          <p className="text-sm font-medium leading-snug text-foreground">
            {headline}
          </p>
          <p className="text-sm leading-snug text-muted-foreground">{body}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Only offered when we are actually inside a host app. On the
              popup-blocked-in-a-real-browser path there is nowhere to escape
              TO: the escape resolves to a same-URL reload, which would drop
              `popupBlocked` (plain component state), dismiss this notice, and
              hand the user straight back to the button that just failed. The
              real remediations there are the force-expanded email form, copy
              link, and try-anyway. */}
          {isInApp && (
          <Button
            type="button"
            size="sm"
            onClick={handleOpen}
            className="cursor-pointer"
            data-testid="inapp-open-browser"
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            open in {browser}
          </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCopy}
            className="cursor-pointer"
            data-testid="inapp-copy-link"
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
            copy link
          </Button>
        </div>

        {/* Same gate: "tap the ••• menu at the top of this window" is nonsense
            advice in desktop Chrome with a popup blocker. */}
        {isInApp && (
          <p className="text-xs leading-snug text-muted-foreground">{manualHint}</p>
        )}

        {onTryAnyway && (
          <button
            type="button"
            onClick={onTryAnyway}
            disabled={tryAnywayDisabled}
            data-testid="inapp-try-google-anyway"
            className="cursor-pointer text-xs hl-link text-accent-cyan disabled:cursor-not-allowed disabled:opacity-50"
          >
            try google anyway
          </button>
        )}
      </>
    </InlineNotice>
  );
}
