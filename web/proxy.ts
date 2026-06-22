import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { evaluateSessionMfa } from '@/lib/sessionManager.server';
import { CURRENT_SECURITY_VERSION, SECURITY_VERSION_HEADER } from '@/lib/securityVersion';

/**
 * Next.js Proxy for Route Protection
 *
 * This runs on the server BEFORE pages load, providing true security.
 * Unlike client-side redirects, this cannot be bypassed by disabling JavaScript.
 *
 * Renamed from `middleware.ts` to `proxy.ts` per Next.js 16's deprecation of
 * the `middleware` file convention. Function signature, config export, and
 * runtime behavior are unchanged — only the file name and exported function
 * name moved (`middleware` → `proxy`).
 *
 * SECURITY UPDATES:
 * - Uses encrypted, HTTPOnly session cookies (iron-session)
 * - Validates session expiration on every request
 * - Cannot be bypassed via JavaScript/XSS attacks
 * - Enforces MFA on protected paths: an authenticated session whose
 *   `mfaRequired && !mfaVerified` is redirected to `/verify-2fa` and
 *   cannot reach `/dashboard`, `/admin`, etc. until the challenge is
 *   completed via `/api/mfa/verify-login` (which marks the cookie verified).
 */

// Protected page routes. These all require an authenticated session AND
// a satisfied MFA challenge (when MFA is enrolled).
const PROTECTED_PATHS = [
  '/dashboard',
  '/deployments',
  '/admin',
  '/roosts',
  '/setup',
  '/add',
  '/cortex',
  // /settings/* (api-keys, webhooks, alerts) manage account + security state and
  // must require completed MFA like the rest of the app — not just password auth.
  '/settings',
] as const;

// The MFA challenge page itself. Reachable for authenticated users whose
// MFA is still pending — otherwise they could never complete it.
const MFA_CHALLENGE_PATH = '/verify-2fa';
const isDev = process.env.NODE_ENV === 'development';
const isEmulatorBuild = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';

function createCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function isScalarApiReferencePath(pathname: string) {
  return pathname === '/docs/api' || pathname === '/docs/api/';
}

function buildContentSecurityPolicy(nonce: string, pathname: string) {
  const scalarApiReference = isScalarApiReferencePath(pathname);
  const scalarFontSource = scalarApiReference ? ' https://fonts.scalar.com' : '';
  const scalarConnectSource = scalarApiReference ? ' https://api.scalar.com' : '';

  return [
    "default-src 'self'",
    // Next.js reads this request CSP before render and applies the nonce to
    // framework inline bootstrap/RSC scripts. `strict-dynamic` lets trusted
    // nonce-bearing scripts load their own children in modern browsers, while
    // the host allowlist remains as a fallback for older CSP implementations.
    // Dev keeps unsafe-eval for Fast Refresh only; production omits it and
    // does not allow unsafe-inline for scripts.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval' " : ''}https://accounts.google.com https://apis.google.com https://*.gstatic.com`,
    // style-src/style-src-elem allow 'unsafe-inline' because Next.js 16
    // emits inline <style> blocks during client-side navigation/hydration
    // that aren't covered by the request-header nonce propagation (which
    // Next applies to scripts only). Without this, the login page hits
    // style-src-elem violations, fails hydration with React error #418, and
    // the form becomes inert. When 'unsafe-inline' is present alongside a
    // nonce, modern browsers ignore 'unsafe-inline' — so we drop the
    // style nonce here intentionally. Style-injection is materially lower
    // risk than script-injection; script-src stays nonce + strict-dynamic.
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: https:${isEmulatorBuild ? ' http://127.0.0.1:*' : ''}`,
    `font-src 'self' data:${scalarFontSource}`,
    `connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://firestore.googleapis.com wss://*.firebaseio.com https://accounts.google.com https://*.ingest.sentry.io https://*.r2.cloudflarestorage.com${scalarConnectSource}${isEmulatorBuild ? ' http://127.0.0.1:* ws://127.0.0.1:*' : ''}`,
    "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join('; ');
}

function setCspHeader(response: NextResponse, csp: string) {
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function nextWithCsp(request: NextRequest, csp: string, nonce: string) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);

  return setCspHeader(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
    csp
  );
}

function redirectWithCsp(url: URL, csp: string, status?: number) {
  return setCspHeader(
    status ? NextResponse.redirect(url, status) : NextResponse.redirect(url),
    csp
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy(nonce, pathname);

  // Legacy redirect: /api/folders/* → /api/roosts/* (folders→roosts rename).
  // Remove 30 days after external users migrated (added 2026-04-22).
  if (pathname.startsWith('/api/folders/') || pathname === '/api/folders') {
    const rewritten = pathname.replace(/^\/api\/folders/, '/api/roosts');
    return redirectWithCsp(new URL(rewritten + search, request.url), csp, 308);
  }

  // Stamp every `/api/*` response with the current security version so
  // stale tabs can detect when they are out of sync with the deployed
  // client and prompt the user to reload. UX nudge only — never a
  // security boundary; see `lib/securityVersion.ts` for rationale.
  if (pathname.startsWith('/api/')) {
    const response = nextWithCsp(request, csp, nonce);
    response.headers.set(SECURITY_VERSION_HEADER, String(CURRENT_SECURITY_VERSION));
    return response;
  }

  const isProtectedPath = PROTECTED_PATHS.some(path => pathname.startsWith(path));
  const isMfaChallengePath = pathname === MFA_CHALLENGE_PATH || pathname.startsWith(`${MFA_CHALLENGE_PATH}/`);

  // Evaluate session + MFA state in one pass. This may persist a one-time
  // migration write for pre-Wave-2 sessions (see `evaluateSessionMfa`).
  const { outcome, userId } = await evaluateSessionMfa(request);
  const isAuthenticated = outcome !== 'unauthenticated';

  // Protected pages: require auth AND a satisfied MFA gate.
  if (isProtectedPath) {
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);

      if (process.env.NODE_ENV === 'development') {
        console.log('[Proxy] Redirecting to login from:', pathname);
      }

      return redirectWithCsp(loginUrl, csp);
    }

    if (outcome === 'challenge') {
      const verifyUrl = new URL(MFA_CHALLENGE_PATH, request.url);
      // Preserve the originally-requested destination so the verify page
      // can bounce the user back after a successful challenge. We use
      // `redirect` to match the login page contract; verify-2fa accepts
      // both `redirect` and the historical `return` param.
      verifyUrl.searchParams.set('redirect', pathname);

      if (process.env.NODE_ENV === 'development') {
        console.log('[Proxy] MFA required — redirecting to verify-2fa from:', pathname);
      }

      return redirectWithCsp(verifyUrl, csp);
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('[Proxy] Allowing access to protected route:', pathname, 'userId:', userId);
    }
  }

  // The MFA challenge page itself must remain reachable for an
  // authenticated-but-unverified user — otherwise they can never complete
  // the challenge. Two policies for the rest of the cases:
  //   - Unauthenticated user lands on /verify-2fa: bounce to /login.
  //   - Authenticated AND already-verified user lands on /verify-2fa:
  //     bounce to /dashboard so they don't re-challenge unnecessarily.
  if (isMfaChallengePath) {
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      return redirectWithCsp(loginUrl, csp);
    }
    if (outcome === 'pass') {
      const redirectParam = request.nextUrl.searchParams.get('redirect')
        ?? request.nextUrl.searchParams.get('return');
      if (
        redirectParam &&
        redirectParam.startsWith('/') &&
        !redirectParam.startsWith('//') &&
        PROTECTED_PATHS.some(p => redirectParam.startsWith(p))
      ) {
        return redirectWithCsp(new URL(redirectParam, request.url), csp);
      }
      return redirectWithCsp(new URL('/dashboard', request.url), csp);
    }
    // outcome === 'challenge' — let the page render so the user can submit
    // their TOTP / backup code.
  }

  // If logged in user tries to access login/register, redirect to
  // dashboard (only when MFA is satisfied — if it's still pending, send
  // them to the challenge instead so they don't get stuck on login).
  if (pathname === '/login' || pathname === '/register') {
    if (isAuthenticated) {
      if (outcome === 'challenge') {
        return redirectWithCsp(new URL(MFA_CHALLENGE_PATH, request.url), csp);
      }

      const redirectParam = request.nextUrl.searchParams.get('redirect');

      if (redirectParam &&
          redirectParam.startsWith('/') &&
          !redirectParam.startsWith('//') &&
          PROTECTED_PATHS.some(path => redirectParam.startsWith(path))) {
        // Only allow redirects to known protected paths (prevents open redirect attacks)
        return redirectWithCsp(new URL(redirectParam, request.url), csp);
      }

      // Default redirect to dashboard
      return redirectWithCsp(new URL('/dashboard', request.url), csp);
    }
  }

  // Allow the request to proceed
  return nextWithCsp(request, csp, nonce);
}

/**
 * Proxy configuration
 * Specifies which routes this proxy should run on
 */
export const config = {
  // Match all routes except static assets. `/api/*` is included so the
  // proxy can stamp the `x-security-version` response header on every API
  // response (see `lib/securityVersion.ts` — UX, not safety).
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - *.png, *.jpg, *.jpeg, *.gif, *.svg, *.ico (image files)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$).*)',
  ],
};
