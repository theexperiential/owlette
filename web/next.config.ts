import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { version } from "./package.json";

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  reactStrictMode: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  allowedDevOrigins: ['http://100.64.45.42:3000'],
  async headers() {
    return [
      {
        // CORS headers for public API endpoints (API key auth, not cookie-based)
        source: '/api/admin/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, x-api-key, Authorization' },
          { key: 'Access-Control-Max-Age', value: '86400' },
        ],
      },
      {
        // Apply security headers to all routes
        source: '/:path*',
        headers: [
          {
            // Prevent clickjacking attacks by disallowing the site to be embedded in iframes
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            // Prevent browsers from MIME-sniffing a response away from the declared content-type
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            // Control how much referrer information is sent with requests
            // strict-origin-when-cross-origin: Send full URL for same-origin, only origin for cross-origin
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // Control which browser features and APIs can be used
            // Disable potentially dangerous features
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            // Enable browser's XSS filter (legacy, but doesn't hurt)
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            // Content Security Policy - controls what resources can be loaded
            // Note: 'unsafe-inline' in style-src is required by Tailwind CSS
            // Note: 'unsafe-inline' in script-src is required by Google OAuth sign-in popups
            // TODO: Replace with nonce-based CSP via Next.js middleware for stronger XSS protection
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com https://*.gstatic.com", // Google OAuth requires inline scripts
              "style-src 'self' 'unsafe-inline'", // Tailwind CSS requires unsafe-inline
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://firestore.googleapis.com wss://*.firebaseio.com https://accounts.google.com https://*.ingest.sentry.io", // Firebase endpoints + Google OAuth
              "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com", // Allow Google OAuth popup and Firebase auth
              "frame-ancestors 'none'", // Equivalent to X-Frame-Options: DENY
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'", // Prevent plugin-based attacks (Flash, Java applets)
              ...(isDev ? [] : ["upgrade-insecure-requests"]), // Force HTTPS for all resources (skip in dev for LAN access)
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Suppress source map upload logs during build
  silent: true,
  // Built-in tunnel route (bypasses ad-blockers)
  tunnelRoute: "/api/sentry-tunnel",
  // Delete source maps after upload so they're not publicly accessible
  sourcemaps: {
    filesToDeleteAfterUpload: [".next/static/**/*.map"],
  },
});
