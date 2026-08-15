import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { createMDX } from "fumadocs-mdx/next";
import { version } from "./package.json";

const e2eDistDir = process.env.OWLETTE_NEXT_DIST_DIR;
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: false,
  ...(e2eDistDir ? { distDir: e2eDistDir } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  allowedDevOrigins,
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  async redirects() {
    return [
      {
        source: '/owlette/api/developer-preview-checklist',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/status-uptime',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/load-testing',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/launch-assets',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/owlette/api/launch-runbook',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/developer-preview-checklist',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/status-uptime',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/load-testing',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/launch-assets',
        destination: '/docs/api',
        permanent: true,
      },
      {
        source: '/docs/api/launch-runbook',
        destination: '/docs/api',
        permanent: true,
      },
      // cortex → hoot rename. `/hoot` is the canonical route; these keep
      // bookmarks, shared conversation links, and anything that still points at
      // the old path working. The API surface keeps its own back-compat aliases
      // under `app/api/cortex/*` (see web/lib/hoot/WIRE_NAMES.md).
      {
        source: '/cortex',
        destination: '/hoot',
        permanent: true,
      },
      {
        source: '/cortex/:chatId',
        destination: '/hoot/:chatId',
        permanent: true,
      },
      {
        source: '/owlette',
        destination: '/docs',
        permanent: true,
      },
      {
        source: '/owlette/:path*',
        destination: '/docs/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      // NOTE: a wildcard CORS block (`Access-Control-Allow-Origin: *`) used to
      // live here for `/api/admin/:path*`. That namespace was removed in
      // 644c57f ("feat(api): eliminate admin namespace") and its routes now
      // live under `/api/platform/*` and `/api/installer/*`. The rule was
      // therefore dead — but it was also a trap: any future `/api/admin/...`
      // route would have silently inherited wildcard CORS. The public API is
      // consumed server-side (CLI, SDKs), which is not subject to CORS, so no
      // replacement is needed. If a browser client is ever added, scope the
      // allowed origin explicitly — never `*` on a namespace that can read
      // cookies.
      {
        // Apply static security headers to all routes.
        // CSP is emitted from proxy.ts instead of next.config.ts because it
        // needs a fresh per-request nonce. Script inline execution must use
        // that nonce (with strict-dynamic) rather than 'unsafe-inline'. Style
        // inline execution allows 'unsafe-inline' because Next 16 emits
        // inline <style> blocks during client navigation that the request-
        // header nonce doesn't cover — see proxy.ts for the full rationale.
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
            // Enforce HTTPS for 1 year — prevents downgrade/MITM attacks
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

const withMDX = createMDX();

export default withSentryConfig(withMDX(nextConfig), {
  // Suppress source map upload logs during build
  silent: true,
  // Built-in tunnel route (bypasses ad-blockers)
  tunnelRoute: "/api/sentry-tunnel",
  // Delete source maps after upload so they're not publicly accessible
  sourcemaps: {
    filesToDeleteAfterUpload: [".next/static/**/*.map"],
  },
});
