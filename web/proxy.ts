import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateSessionFromRequest } from '@/lib/sessionManager.server';

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
  const { pathname } = request.nextUrl;

  // Define protected routes
  const protectedPaths = ['/dashboard', '/deployments', '/admin', '/projects', '/setup', '/add'];

  // Define public routes (no auth required)
  const publicPaths = ['/', '/login', '/register'];

  // Check if current path is protected
  const isProtectedPath = protectedPaths.some(path =>
    pathname.startsWith(path)
  );

  const isPublicPath = publicPaths.some(path =>
    pathname === path || pathname.startsWith(path)
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
  // Match all routes except:
  // - API routes
  // - Static files (_next/static)
  // - Image optimization files (_next/image)
  // - Favicon and other public files
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - *.png, *.jpg, *.jpeg, *.gif, *.svg, *.ico (image files)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$).*)',
  ],
};
