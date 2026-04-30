/**
 * Landing — hero regression
 *
 * Locks down the marketing-critical pieces of the public landing page so
 * accidental copy/CTA edits show up in CI instead of in production. The
 * landing page is public, so this spec runs without a storage state.
 *
 * Animation timing (the RotatingWord cycle) is intentionally not asserted —
 * we only check that one of the rotator's prefix words is present at the
 * initial render, which is deterministic.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const HERO_HEADLINE = /attention is all you need/i;

test.describe('landing — hero', () => {
  test('hero renders', async ({ page }) => {
    await page.goto('/');

    const hero = page.locator('section', {
      has: page.getByRole('heading', { name: HERO_HEADLINE }),
    }).first();

    // Headline. The accessible name flattens the inline <br> so a single
    // case-insensitive match works on both mobile and desktop layouts.
    await expect(
      hero.getByRole('heading', { name: HERO_HEADLINE }),
    ).toBeVisible();

    // Primary CTA in the hero → /register.
    await expect(
      hero.getByRole('link', { name: 'get started', exact: true }),
    ).toHaveAttribute('href', '/register');

    // Secondary CTA in the hero → /demo.
    await expect(
      hero.getByRole('link', { name: 'see the live demo', exact: true }),
    ).toHaveAttribute('href', '/demo');

    // Platform pill row — substring matches so casing/punctuation tweaks
    // around the middots don't false-positive this regression.
    const pillRow = hero.locator('p', { hasText: 'windows only' });
    await expect(pillRow).toBeVisible();
    await expect(pillRow).toContainText('windows only');
    await expect(pillRow).toContainText('free during beta');
    await expect(pillRow).toContainText('FSL-1.1');

    // Rotator subhead — the initial prefix word ('monitor') is rendered
    // before any cycling kicks in. RotatingWord nests three spans:
    //   1. an aria-hidden absolute "measurer" used for sizing
    //   2. an outer inline-flex wrapper that carries width transitions
    //   3. an inner span (`transition-all duration-400 ...`) holding the
    //      actual visible word
    // hasText matches both (2) and (3) via inherited text content. Anchor
    // on the inner span's unique class so strict-mode lands a single hit.
    await expect(
      hero.locator('span.transition-all.duration-400').filter({ hasText: /^monitor$/ }),
    ).toBeVisible();

    // Owl eye SVG — animated eye carries the `animate-eye-ignite` class.
    await expect(hero.locator('svg.animate-eye-ignite')).toBeVisible();
  });
});
