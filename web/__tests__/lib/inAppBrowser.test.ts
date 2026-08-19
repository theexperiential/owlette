/**
 * In-app browser detection (lib/inAppBrowser).
 *
 * The user-agent fixtures below are real strings, not invented ones — the
 * LinkedIn case is the exact UA from the production Sentry event that motivated
 * this module (OWLETTE-WEB-45). Detection here decides whether we hide a
 * working sign-in button, so the negative cases matter as much as the positive
 * ones: a false positive on real Safari would degrade the happy path for every
 * iPhone visitor.
 */
import {
  buildAndroidIntentUrl,
  buildEscapeTarget,
  detectInAppBrowser,
  detectPlatform,
  isPopupUnavailableError,
  systemBrowserLabel,
} from '@/lib/inAppBrowser';

const UA = {
  /** Verbatim from the OWLETTE-WEB-45 event. */
  linkedInIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.32.2485',
  safariIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
  chromeDesktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  instagramIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.1.2.29.89',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  /** iOS Home Screen web app — no Version/ and no Safari/ token, same as a webview. */
  iosStandalonePwa:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
};

describe('detectInAppBrowser', () => {
  it('identifies the LinkedIn iOS webview from the production user-agent', () => {
    expect(detectInAppBrowser(UA.linkedInIOS)).toEqual({
      isInApp: true,
      appKey: 'linkedin',
      appName: 'LinkedIn',
    });
  });

  it('identifies other common host apps', () => {
    const instagram = detectInAppBrowser(UA.instagramIOS);
    expect(instagram.isInApp).toBe(true);
    expect(instagram.appKey).toBe('instagram');
  });

  // The false-positive cases. Getting these wrong hides a button that works.
  it.each([
    ['real mobile Safari', UA.safariIOS],
    ['desktop Chrome', UA.chromeDesktop],
    ['Android Chrome', UA.chromeAndroid],
  ])('does not flag %s', (_label, ua) => {
    expect(detectInAppBrowser(ua).isInApp).toBe(false);
  });

  it('reports "not in app" for an empty user-agent rather than throwing', () => {
    expect(detectInAppBrowser('')).toEqual({ isInApp: false });
  });

  // An iOS Home Screen web app drops the Version/ and Safari/ tokens exactly
  // like a webview does, so inapp-spy's catch-all iOS rule matches it and an
  // installed PWA would otherwise be told it is "an in-app browser" inside its
  // own window — and lose its passkey button. We ship an installable manifest
  // (public/manifest.json, display: standalone), so this is a live path.
  describe('iOS standalone web app', () => {
    const setStandalone = (value: boolean | undefined) => {
      if (value === undefined) {
        delete (navigator as Navigator & { standalone?: boolean }).standalone;
        return;
      }
      Object.defineProperty(navigator, 'standalone', {
        value,
        configurable: true,
        writable: true,
      });
    };

    afterEach(() => setStandalone(undefined));

    it('is not treated as an in-app browser', () => {
      setStandalone(true);
      expect(detectInAppBrowser(UA.iosStandalonePwa).isInApp).toBe(false);
    });

    it('is still treated as in-app when navigator.standalone is absent', () => {
      setStandalone(undefined);
      // Same ambiguous UA in a third-party webview that WebKit never flags —
      // failing open here keeps unidentified host apps working.
      expect(detectInAppBrowser(UA.iosStandalonePwa).isInApp).toBe(true);
    });

    it('does not let the standalone flag override a positively named host app', () => {
      setStandalone(true);
      expect(detectInAppBrowser(UA.linkedInIOS)).toEqual({
        isInApp: true,
        appKey: 'linkedin',
        appName: 'LinkedIn',
      });
    });
  });
});

describe('isPopupUnavailableError', () => {
  it.each([
    'auth/popup-blocked',
    'auth/operation-not-supported-in-this-environment',
  ])('matches %s', (code) => {
    expect(isPopupUnavailableError({ code })).toBe(true);
  });

  // These already have their own handling in AuthContext — a user who closed
  // the popup themselves must not be shown the in-app remediation.
  it.each([
    'auth/popup-closed-by-user',
    'auth/cancelled-popup-request',
    'auth/wrong-password',
  ])('does not match %s', (code) => {
    expect(isPopupUnavailableError({ code })).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain Error', new Error('boom')],
    ['a string', 'auth/popup-blocked'],
    ['a non-string code', { code: 42 }],
  ])('does not match %s', (_label, value) => {
    expect(isPopupUnavailableError(value)).toBe(false);
  });
});

describe('detectPlatform / systemBrowserLabel', () => {
  it.each([
    [UA.linkedInIOS, 'ios', 'safari'],
    [UA.safariIOS, 'ios', 'safari'],
    [UA.chromeAndroid, 'android', 'chrome'],
    [UA.chromeDesktop, 'other', 'your browser'],
  ])('maps %s', (ua, platform, label) => {
    expect(detectPlatform(ua)).toBe(platform);
    expect(systemBrowserLabel(ua)).toBe(label);
  });
});

describe('buildEscapeTarget', () => {
  it('adds the escape marker', () => {
    expect(buildEscapeTarget('https://owlette.app/register')).toBe(
      'https://owlette.app/register?iab=1',
    );
  });

  it('preserves existing query params', () => {
    const result = buildEscapeTarget('https://owlette.app/login?redirect=%2Fdashboard');
    expect(result).toContain('redirect=%2Fdashboard');
    expect(result).toContain('iab=1');
  });

  // The marker is what tells the notice to escalate to manual instructions, so
  // a second attempt must not accumulate duplicates in the URL.
  it('is idempotent', () => {
    const once = buildEscapeTarget('https://owlette.app/register');
    expect(buildEscapeTarget(once)).toBe(once);
  });

  it('returns the input unchanged when it is not a parseable URL', () => {
    expect(buildEscapeTarget('not a url')).toBe('not a url');
  });
});

describe('buildAndroidIntentUrl', () => {
  it('builds a browser-targeted intent with a fallback url', () => {
    const intent = buildAndroidIntentUrl('https://owlette.app/register?iab=1');

    expect(intent).toBe(
      'intent://owlette.app/register?iab=1#Intent;scheme=https;' +
        'action=android.intent.action.VIEW;' +
        'S.browser_fallback_url=https%3A%2F%2Fowlette.app%2Fregister%3Fiab%3D1;end',
    );
  });

  // The `#Intent;…;end` block IS the fragment. A fragment left on the URL both
  // breaks parsing and would let `#Intent;package=…` crafted on our own origin
  // inject intent parameters, so it has to be dropped.
  it('drops any existing fragment', () => {
    const intent = buildAndroidIntentUrl(
      'https://owlette.app/register#Intent;scheme=https;package=com.attacker;end',
    );

    expect(intent).not.toContain('com.attacker');
    expect(intent.match(/#Intent;/g)).toHaveLength(1);
  });

  // `;` terminates an intent parameter, so a semicolon surviving unencoded in
  // the query would let the query inject into the intent block.
  it('percent-encodes semicolons carried in the query', () => {
    const intent = buildAndroidIntentUrl(
      buildEscapeTarget('https://owlette.app/register?redirect=%3Bpackage%3Dcom.attacker'),
    );

    expect(intent).not.toContain(';package=com.attacker');
  });
});
