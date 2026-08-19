/**
 * In-app browser (embedded webview) detection and remediation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Federated Google sign-in cannot work inside a third-party app's embedded
 * webview, and there is no configuration that changes that:
 *
 *  1. `signInWithPopup` throws `auth/popup-blocked`, because iOS WKWebView
 *     returns null from `window.open()` unless the HOST app opts in (it must
 *     set `javaScriptCanOpenWindowsAutomatically`, which defaults to false on
 *     iOS, AND implement `WKUIDelegate.webView(_:createWebViewWith:…)`). Those
 *     are build-time properties of someone else's binary, so for a given host
 *     app this fails 100% of the time, not intermittently.
 *  2. `signInWithRedirect` is not a fallback. Google's OAuth authorization
 *     endpoint rejects requests rendered in an embedded user-agent outright
 *     (`disallowed_useragent`), so the redirect never returns a Firebase error
 *     code we could catch — it just strands the user on an error page. See
 *     https://developers.google.com/identity/protocols/oauth2/native-app
 *     Separately, our authDomain is `*.firebaseapp.com` while the app is served
 *     from owlette.app, which is exactly the cross-origin configuration WebKit
 *     storage partitioning breaks.
 *
 * So the only remediation is to leave the webview or use a credential that
 * doesn't involve a third-party identity provider. This module supports both.
 *
 * FAIL OPEN, ALWAYS. Every function here degrades to "not an in-app browser"
 * on any error. A false positive must never be able to block sign-in — the
 * callers de-emphasise Google, they never remove it.
 */
import InAppSpy from 'inapp-spy';

export interface InAppBrowserInfo {
  /** True when running inside a third-party app's embedded webview. */
  isInApp: boolean;
  /** Host app display name ("LinkedIn"), when the UA identifies one. */
  appName?: string;
  /** Stable host app key ("linkedin"), when the UA identifies one. */
  appKey?: string;
}

/** Shared negative result. Frozen so a caller can't mutate the default. */
const NOT_IN_APP: InAppBrowserInfo = Object.freeze({ isInApp: false });

/**
 * Marker appended to the URL we hand to the system browser.
 *
 * Deliberately NOT used to suppress the notice on return. If the escape
 * succeeded the user is in Safari and detection is negative anyway; if it
 * failed they are still in the webview and still need the guidance. What the
 * marker buys is knowing the easy escape has already been tried, so the copy
 * can escalate straight to the manual instructions instead of repeating an
 * affordance that just did nothing.
 */
export const ESCAPE_MARKER_PARAM = 'iab';

/**
 * Identify the host app, if any.
 *
 * `ua` is injectable for tests; in the browser it defaults to
 * `navigator.userAgent`. Returns `NOT_IN_APP` during SSR — callers must run
 * this after mount (see `useInAppBrowser`), because a server render that
 * disagrees with the first client render is a hydration mismatch.
 *
 * Note we use only inapp-spy's synchronous UA matching. Its
 * `SFSVCExperimental` probe is deliberately not used: SFSafariViewController
 * and Chrome Custom Tabs are NOT embedded webviews — they are the real browser
 * and popups work fine there — so probing for them only adds a false-positive
 * surface, and the probe has broken on a Safari point release before.
 */
export function detectInAppBrowser(ua?: string): InAppBrowserInfo {
  const agent = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (!agent) return NOT_IN_APP;

  try {
    const { isInApp, appName, appKey } = InAppSpy({ ua: agent });
    if (!isInApp) return NOT_IN_APP;

    // inapp-spy's catch-all iOS rule is `(iPhone|iPod|iPad)(?!.*Safari/)`, and
    // an iOS Home Screen web app drops the `Version/` and `Safari/` tokens for
    // exactly the same reason a webview does — the user-agent alone cannot
    // separate them, and we ship an installable manifest (display: standalone).
    // Without this guard an installed PWA is told "google sign-in doesn't work
    // in this in-app browser" inside its own window, and loses its passkey
    // button, even though it is first-party WebKit on our own origin.
    //
    // Gated on `!appKey` deliberately: a UA that positively names LinkedIn or
    // Instagram is in-app no matter what else is true, and only the generic
    // rule is ambiguous. And on `navigator.standalone`, NOT
    // matchMedia('(display-mode: standalone)') — chrome-less third-party
    // webviews can match that media query, which would suppress genuine
    // detection and walk straight back into OWLETTE-WEB-45.
    if (!appKey && isIOSStandalone()) return NOT_IN_APP;

    return { isInApp: true, appName, appKey };
  } catch {
    // Detection is an enhancement, never a gate.
    return NOT_IN_APP;
  }
}

/** True in an iOS Home Screen web app. Set only by first-party WebKit. */
function isIOSStandalone(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Firebase error codes meaning "this environment cannot open a sign-in popup".
 *
 * Single source of truth — AuthContext decides whether to toast on these, and
 * both auth pages decide whether to render the remediation notice, so a code
 * added here has to reach all three or the surfaces disagree.
 */
const POPUP_UNAVAILABLE_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
]);

/** True when the error means the browser refused to open the sign-in popup. */
export function isPopupUnavailableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && POPUP_UNAVAILABLE_CODES.has(code);
}

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(ua?: string): Platform {
  const agent = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return platformOf(agent);
}

/**
 * What to call the system browser in user-facing copy. Naming the actual app
 * ("safari") is markedly more actionable than "your browser", but only when we
 * know the platform.
 */
export function systemBrowserLabel(ua?: string): string {
  switch (detectPlatform(ua)) {
    case 'ios':
      return 'safari';
    case 'android':
      return 'chrome';
    default:
      return 'your browser';
  }
}

function platformOf(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ reports a desktop Macintosh UA; touch points disambiguate it.
  if (
    /Macintosh/i.test(ua) &&
    typeof navigator !== 'undefined' &&
    navigator.maxTouchPoints > 1
  ) {
    return 'ios';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

/** Current page URL carrying the escape marker. Exported for tests. */
export function buildEscapeTarget(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.set(ESCAPE_MARKER_PARAM, '1');
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * Android intent URL that hands the page to the default browser.
 *
 * The `#Intent;…;end` block IS the fragment, so any fragment already on the
 * page has to be dropped — leaving it in place would both break parsing (the
 * first `#` wins) and let a crafted `#Intent;package=…` on our own origin
 * inject intent parameters. Everything else survives: the path and query are
 * carried by the URL object, which percent-encodes the `;` that would
 * otherwise terminate the intent block early.
 *
 * Exported for tests — the real call navigates, which jsdom cannot follow.
 */
export function buildAndroidIntentUrl(href: string): string {
  let scheme = 'https';
  let rest = href.replace(/^[a-z]+:\/\//i, '');

  try {
    const url = new URL(href);
    url.hash = '';
    scheme = url.protocol.replace(':', '');
    rest = `${url.host}${url.pathname}${url.search}`;
  } catch {
    // Fall back to the naive split; a malformed href can only fail closed here
    // (the intent simply won't resolve), never navigate somewhere unintended.
  }

  const fallback = encodeURIComponent(`${scheme}://${rest}`);
  return (
    `intent://${rest}#Intent;scheme=${scheme};` +
    `action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end`
  );
}

/**
 * Best-effort hand-off to the system browser. Returns the scheme attempted so
 * callers can log it; the webview gives us no completion signal, so there is
 * no way to know whether it worked.
 *
 * CRITICAL: this uses `location.href`, never `window.open`. `window.open` is
 * the exact primitive that returns null in this environment — reaching for it
 * here would reproduce the bug we are working around.
 *
 * The iOS `x-safari-` scheme is a private, undocumented Apple scheme with no
 * compatibility guarantee, and it is already dead in several host apps
 * (TikTok, X, WeChat, Snapchat). It is offered as a shortcut that costs one
 * tap, NOT as the mechanism — the notice must always also carry the manual
 * "open in browser" instructions, because for many users this will do nothing.
 */
export function escapeToSystemBrowser(href?: string): Platform {
  if (typeof window === 'undefined') return 'other';

  const target = buildEscapeTarget(href ?? window.location.href);
  const platform = platformOf(navigator.userAgent);

  if (platform === 'ios') {
    window.location.href = `x-safari-${target}`;
    return platform;
  }

  if (platform === 'android') {
    window.location.href = buildAndroidIntentUrl(target);
    return platform;
  }

  window.location.href = target;
  return platform;
}

/**
 * Copy a URL to the clipboard.
 *
 * MUST be called synchronously from a user-gesture handler — WebKit rejects
 * the clipboard promise outside one, so awaiting anything before this call
 * silently breaks it. Falls back to the legacy textarea+execCommand path,
 * which several in-app webviews still need.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }

  if (typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Off-screen but still selectable; `display:none` can't be selected. Note
  // that this leaves it in the tab order and the accessibility tree, which is
  // exactly why removal below is unconditional — an orphaned copy would be
  // tabbable from the email field and announced by a screen reader.
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Sentry tags/extra describing the current browsing environment.
 *
 * The raw user-agent is the load-bearing field: Sentry's parsed `browser`
 * family collapses every unrecognised iOS webview to "Mobile Safari
 * UI/WKWebView", which is a fallback rule in uap-core rather than a real
 * browser name — the host app is only recoverable from the raw string. Any
 * alerting should key off this, not the parsed family, since uap-core adds
 * new host-app rules over time.
 */
export function inAppDiagnostics(): {
  tags: Record<string, string>;
  extra: Record<string, unknown>;
} {
  if (typeof navigator === 'undefined') {
    return { tags: {}, extra: {} };
  }

  const ua = navigator.userAgent;
  const info = detectInAppBrowser(ua);

  return {
    tags: {
      in_app_browser: String(info.isInApp),
      in_app_app: info.appKey ?? 'unknown',
      in_app_platform: platformOf(ua),
    },
    extra: {
      userAgent: ua,
      // Distinguishes an installed PWA from an embedded webview; the Firebase
      // SDK short-circuits before window.open in standalone mode, so this
      // should always be false on the popup-blocked path.
      standalone:
        (navigator as Navigator & { standalone?: boolean }).standalone ?? null,
      displayModeStandalone:
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(display-mode: standalone)').matches
          : null,
    },
  };
}
