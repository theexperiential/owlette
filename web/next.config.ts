import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
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
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
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
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://firestore.googleapis.com wss://*.firebaseio.com https://accounts.google.com", // Firebase endpoints + Google OAuth
              "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com", // Allow Google OAuth popup and Firebase auth
              "frame-ancestors 'none'", // Equivalent to X-Frame-Options: DENY
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'", // Prevent plugin-based attacks (Flash, Java applets)
              "upgrade-insecure-requests", // Force HTTPS for all resources
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
