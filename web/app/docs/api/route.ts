import { ApiReference } from '@scalar/nextjs-api-reference';
import type { NextRequest } from 'next/server';

/**
 * owlette branding + readability polish layered onto the Scalar theme.
 *
 * Selectors verified against the rendered Scalar DOM (api-reference loaded from
 * the jsdelivr CDN) — not guessed:
 *  - `.t-doc__sidebar` is a `flex-direction: column` container whose first child
 *    is the search row, so a `::before` becomes the first flex item and pins the
 *    owl mark + wordmark to the top-left of the sidebar (desktop `lg:flex`; the
 *    sidebar is `hidden` below `lg`, where Scalar shows its own mobile bar).
 *  - The page title is `.introduction-section .section-header` (24px by default);
 *    the `.scalar-app` prefix raises specificity above Scalar's
 *    `.section-header[data-v-…]` rule so the larger size wins.
 *  - Section headers and body copy both render at `--scalar-color-1` (#f7f8f8),
 *    which is why they read as low-contrast. Scalar's markdown headings and
 *    paragraphs have no own `color`, so setting the `.markdown` container to
 *    `--scalar-color-2` dims the copy via inheritance while re-asserting
 *    `--scalar-color-1` on headings keeps them at full strength.
 */
const CUSTOM_CSS = `
/* owl mark + wordmark, pinned to the top-left of the sidebar */
.t-doc__sidebar::before {
  content: 'owlette api';
  display: block;
  margin: 14px 12px 8px;
  padding-left: 30px;
  min-height: 24px;
  line-height: 24px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--scalar-color-1);
  background: url('/owlette-eye.svg') left center / 22px 22px no-repeat;
}

/* larger page title (the info.title heading in the introduction); the
 * margin-top opens a gap from the version/OpenAPI badge row (a flex row of
 * .badge pills) that renders directly above it with no spacing of its own */
.scalar-app .introduction-section .section-header {
  font-size: 36px;
  line-height: 1.15;
  margin-top: 12px;
}

/* stronger hierarchy: keep headings at full strength, dim body copy */
.scalar-app .markdown {
  color: var(--scalar-color-2);
}
.scalar-app .markdown :is(h1, h2, h3, h4, h5, h6) {
  color: var(--scalar-color-1);
}
`;

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
  favicon: '/owlette-eye.svg',
  customCss: CUSTOM_CSS,
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
