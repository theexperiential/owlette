/**
 * Mobile-viewport helpers — used by the `mobile-chromium` Playwright project
 * (see playwright.config.ts), which runs specs/mobile/** at 390x844 with
 * touch enabled.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Freeze the page before measuring layout (same approach as
 * e2e/specs/a11y/route-smoke.spec.ts): kill animations, settle the hero's
 * entrance states, await webfonts. Without it a mid-flight transform or a
 * fallback-font reflow briefly widens the document and flaps overflow asserts.
 * Idempotent.
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
 * Assert no horizontal scroll at the current viewport. Checks documentElement AND
 * body: a child escaping an overflow-hidden body still widens documentElement,
 * and a body can overflow while documentElement looks clean. 1px tolerance
 * absorbs the rounded-up integer `scrollWidth` on fractional layouts.
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

    // name the widest offenders; a bare "1091 > 391" is not actionable
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

/**
 * Assert one control is fully inside the viewport box.
 * {@link assertNoHorizontalOverflow} measures document scroll width and is blind
 * to a position-fixed surface (dialog, portalled sheet) overflowing on its own,
 * so controls inside one need this direct check. Scrolled into view first —
 * vertical scrolling is normal on a phone; only the resting geometry is claimed.
 */
export async function expectFullyWithinViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  // matches assertNoHorizontalOverflow: sub-pixel layout rounding
  const TOLERANCE = 1;

  const viewport = page.viewportSize();
  expect(viewport, `${label}: viewportSize() is null — this helper needs a fixed viewport`)
    .not.toBeNull();

  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label} has no bounding box — it is not rendered`).not.toBeNull();

  const { x, y, width, height } = box!;
  const { width: vw, height: vh } = viewport!;
  const withinViewport =
    x >= -TOLERANCE &&
    y >= -TOLERANCE &&
    x + width <= vw + TOLERANCE &&
    y + height <= vh + TOLERANCE;

  expect(
    withinViewport,
    `${label} is not fully inside the ${vw}x${vh} viewport — measured ` +
      `left ${Math.round(x)}, top ${Math.round(y)}, ` +
      `right ${Math.round(x + width)}, bottom ${Math.round(y + height)}`,
  ).toBe(true);
}
