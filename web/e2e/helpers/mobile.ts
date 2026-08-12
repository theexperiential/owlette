/**
 * Mobile-viewport helpers — used by the `mobile-chromium` Playwright project
 * (see playwright.config.ts), which runs specs/mobile/** at 390x844 with
 * touch enabled.
 */

import { expect, type Page } from '@playwright/test';

/**
 * Freeze the page before measuring layout.
 *
 * Mirrors the stabilization used by the a11y smoke suite
 * (e2e/specs/a11y/route-smoke.spec.ts): kill every animation/transition, force
 * the landing hero's entrance states to their resting values, then wait for
 * webfonts. Without this, a mid-flight transform or a fallback-font reflow can
 * momentarily widen the document and make an overflow assertion flap.
 *
 * Safe to call more than once — the injected style tag is idempotent in effect.
 */
export async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }

      .hero-enter,
      .hero-enter-nav,
      .hero-enter-delay-1,
      .hero-enter-delay-2,
      .hero-enter-delay-3 {
        opacity: 1 !important;
        transform: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts?.ready;
  });
}

/**
 * Assert the page does not scroll horizontally at the current viewport.
 *
 * Checks both `document.documentElement` and `document.body`: a child that
 * escapes an `overflow-hidden` body still widens the documentElement, and a
 * body with its own width can overflow while the documentElement looks clean.
 *
 * The 1px tolerance absorbs sub-pixel rounding — fractional layout widths get
 * reported as a rounded-up integer `scrollWidth`, which otherwise reads as a
 * one-pixel overflow on a perfectly fitting page.
 *
 * Calls {@link stabilize} first so callers can't measure a page mid-animation.
 */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  await stabilize(page);

  const overflow = await page.evaluate(() => {
    const TOLERANCE = 1;
    const roots = [
      { name: 'documentElement', el: document.documentElement },
      { name: 'body', el: document.body },
    ].filter((entry) => !!entry.el);

    const offenders = roots
      .filter((entry) => entry.el.scrollWidth > entry.el.clientWidth + TOLERANCE)
      .map((entry) => ({
        root: entry.name,
        scrollWidth: entry.el.scrollWidth,
        clientWidth: entry.el.clientWidth,
      }));

    if (offenders.length === 0) return { offenders, culprits: [] as string[] };

    // Name the widest elements poking past the viewport — a bare
    // "1091 > 391" failure is not actionable on a real dashboard page.
    const viewportWidth = document.documentElement.clientWidth;
    const culprits = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((entry) => entry.right > viewportWidth + TOLERANCE)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.el.tagName.toLowerCase()}${entry.el.id ? `#${entry.el.id}` : ''}` +
          `${entry.el.className && typeof entry.el.className === 'string' ? `.${entry.el.className.trim().split(/\s+/).join('.')}` : ''}` +
          ` (right: ${Math.round(entry.right)}px)`,
      );

    return { offenders, culprits };
  });

  expect(
    overflow.offenders,
    overflow.culprits.length > 0
      ? `horizontal overflow at ${page.url()} — widest offenders: ${overflow.culprits.join(', ')}`
      : `horizontal overflow at ${page.url()}`,
  ).toEqual([]);
}
