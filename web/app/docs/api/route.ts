import { ApiReference } from '@scalar/nextjs-api-reference';
import type { NextRequest } from 'next/server';

/**
 * GET /docs/api — interactive Scalar API reference.
 *
 * The Scalar Next.js integration emits two un-nonced <script> tags (the
 * jsdelivr CDN loader + the inline `createApiReference` init). Our CSP uses
 * `'strict-dynamic'` plus a per-request nonce (see `proxy.ts`), which means
 * the browser runs ONLY nonce-bearing scripts and ignores the host allowlist
 * entirely — so both Scalar scripts get blocked and the page renders blank.
 * Scalar v0.10.x exposes no nonce option, so we render its HTML and stamp the
 * per-request nonce (carried on the `x-nonce` request header the proxy sets)
 * onto every <script> tag. With `strict-dynamic`, that nonce also covers any
 * chunks the bundle loads dynamically.
 *
 * Reading the request header forces this route to be dynamic, so the stamped
 * nonce always matches the Content-Security-Policy header for the same request.
 */
const renderReference = ApiReference({
  url: '/api/openapi',
  title: 'owlette API Reference',
  theme: 'kepler',
  darkMode: true,
  hideDownloadButton: false,
  metaData: {
    title: 'owlette API Reference',
    description: 'Interactive API documentation for the owlette fleet management platform',
  },
});

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const nonce = request.headers.get('x-nonce');
  const html = await renderReference().text();
  const body = nonce
    ? html.replace(/<script /g, `<script nonce="${nonce}" `)
    : html;

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
