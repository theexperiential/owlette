import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateSessionFromRequest } from '@/lib/sessionManager.server';
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
 */

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Legacy redirect: /api/folders/* → /api/roosts/* (folders→roosts rename).
  // Remove 30 days after external users migrated (added 2026-04-22).
  if (pathname.startsWith('/api/folders/') || pathname === '/api/folders') {
    const rewritten = pathname.replace(/^\/api\/folders/, '/api/roosts');
    return NextResponse.redirect(new URL(rewritten + search, request.url), 308);
  }

  // Stamp every `/api/*` response with the current security version so
  // stale tabs can detect when they are out of sync with the deployed
  // client and prompt the user to reload. UX nudge only — never a
  // security boundary; see `lib/securityVersion.ts` for rationale.
  if (pathname.startsWith('/api/')) {
    const response = NextResponse.next();
    response.headers.set(SECURITY_VERSION_HEADER, String(CURRENT_SECURITY_VERSION));
    return response;
  }

  // Define protected routes
  const protectedPaths = ['/dashboard', '/deployments', '/admin', '/roosts', '/setup', '/add', '/cortex'];

  // Check if current path is protected
  const isProtectedPath = protectedPaths.some(path =>
    pathname.startsWith(path)
  );

  // Validate session using encrypted, HTTPOnly cookies
  const userId = await validateSessionFromRequest(request);
  const isAuthenticated = userId !== null;

  // If accessing a protected route
  if (isProtectedPath) {
    // If not authenticated, redirect to login
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      // Save the intended destination so we can redirect after login
      loginUrl.searchParams.set('redirect', pathname);

      if (process.env.NODE_ENV === 'development') {
        console.log('[Proxy] Redirecting to login from:', pathname);
      }

      return NextResponse.redirect(loginUrl);
    }

    // User is authenticated, allow access
    if (process.env.NODE_ENV === 'development') {
      console.log('[Proxy] Allowing access to protected route:', pathname, 'userId:', userId);
    }
  }

  // If logged in user tries to access login/register, redirect to dashboard
  if (pathname === '/login' || pathname === '/register') {
    if (isAuthenticated) {
      // Check if there's a redirect parameter
      const redirectParam = request.nextUrl.searchParams.get('redirect');

      if (redirectParam &&
          redirectParam.startsWith('/') &&
          !redirectParam.startsWith('//') &&
          protectedPaths.some(path => redirectParam.startsWith(path))) {
        // Only allow redirects to known protected paths (prevents open redirect attacks)
        return NextResponse.redirect(new URL(redirectParam, request.url));
      }

      // Default redirect to dashboard
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  // Allow the request to proceed
  return NextResponse.next();
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
