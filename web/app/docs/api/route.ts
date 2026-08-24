import { ApiReference } from '@scalar/nextjs-api-reference';
import type { NextRequest } from 'next/server';

/**
 * owlette branding layered onto the Scalar theme. Selectors were verified
 * against the rendered Scalar DOM, not guessed:
 *  - `.t-doc__sidebar` is a column flex container, so `::before` becomes its
 *    first item and pins the wordmark above the search row.
 *  - The `.scalar-app` prefix on `.section-header` is needed to outrank
 *    Scalar's own `.section-header[data-v-…]` rule.
 *  - Scalar renders headings and body copy at the same `--scalar-color-1`.
 *    Its markdown headings/paragraphs set no `color`, so dimming `.markdown`
 *    to `--scalar-color-2` and re-asserting `-1` on headings restores contrast.
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

/* margin-top opens a gap from the badge row above, which has none of its own */
.scalar-app .introduction-section .section-header {
  font-size: 36px;
  line-height: 1.15;
  margin-top: 12px;
}

/* headings at full strength, body copy dimmed */
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
 * Scalar emits two un-nonced <script> tags, and our `strict-dynamic` CSP runs
 * ONLY nonce-bearing scripts (the host allowlist is ignored), so the page
 * rendered blank. Scalar v0.10.x has no nonce option, so we stamp the
 * per-request nonce from the proxy's `x-nonce` header onto every <script>;
 * strict-dynamic then covers dynamically-loaded chunks too.
 *
 * Reading that header forces the route dynamic, which is what keeps the stamped
 * nonce matching the CSP header of the same request.
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
