'use client';

import { CircleAlertIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  copyToClipboard,
  escapeToSystemBrowser,
  systemBrowserLabel,
} from '@/lib/inAppBrowser';

/**
 * Explains why federated sign-in is unavailable, and offers the only two
 * remediations that exist: leave the webview, or use a credential that doesn't
 * involve a third-party identity provider (the email form below it).
 *
 * Inline rather than a toast, on the same reasoning as `ui/form-error`: this
 * is a blocking condition the user must act on, not the outcome of an action,
 * so it has to persist until resolved rather than expire in a corner. The
 * previous behaviour — two stacked generic toasts reading "An error occurred.
 * Please try again" — told the user nothing and left them with no next step.
 *
 * Rendered on two triggers, and the copy adapts to both:
 *  - pre-emptively, when the host app is identified before the user taps
 *    anything (the common case, and the only one that saves a wasted tap);
 *  - reactively, when `auth/popup-blocked` fires anyway. That covers webviews
 *    the UA doesn't identify, and ordinary browsers where a popup blocker or a
 *    broken gesture chain got in the way.
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
  /** Fail open: let the user attempt Google regardless of what we detected. */
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

  // The one-tap escape relies on a private, undocumented URL scheme that many
  // host apps ignore, so the manual route is always shown — never as a
  // consolation after a failure we cannot even detect.
  const manualHint = escapeAttempted
    ? `still here? the shortcut didn't work in this app — tap the ••• menu at the top of this window and choose "open in ${browser}".`
    : 'if nothing happens, tap the ••• menu at the top of this window and choose "open in browser".';

  const handleOpen = () => {
    escapeToSystemBrowser();
  };

  const handleCopy = () => {
    // Not an async handler on purpose: WebKit rejects the clipboard promise
    // unless writeText is reached synchronously from the user gesture, so
    // nothing may be awaited before the call.
    void copyToClipboard(window.location.href).then((ok) => {
      if (ok) {
        toast.success('link copied — paste it into your browser');
      } else {
        toast.error('could not copy the link');
      }
    });
  };

  return (
    <div
      role="alert"
      data-testid="inapp-browser-notice"
      className={cn(
        'flex items-start gap-2 rounded-md border border-border bg-secondary/60 p-3',
        className,
      )}
    >
      <CircleAlertIcon
        className="mt-0.5 size-4 shrink-0 text-accent-cyan"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-3">
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
      </div>
    </div>
  );
}
