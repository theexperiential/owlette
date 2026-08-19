/**
 * Landing — hero regression
 *
 * Locks down the marketing-critical pieces of the public landing page so
 * accidental copy/CTA edits show up in CI instead of in production. The
 * landing page is public, so this spec runs without a storage state.
 */

import { test, expect } from '@playwright/test';
import { HERO_HEADLINE, HERO_SUBHEADLINE } from '../../helpers/landing';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — hero', () => {
  test('hero renders', async ({ page }) => {
    await page.goto('/');

    const hero = page.locator('section', {
      has: page.getByRole('heading', { name: HERO_HEADLINE }),
    }).first();

    // Headline — whichever phrase this request rolled from HERO_HEADLINES.
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

    // Subhead — static copy, so a plain text match is deterministic.
    await expect(hero.getByText(HERO_SUBHEADLINE)).toBeVisible();

    // Owl eye SVG — animated eye carries the `animate-eye-ignite` class.
    await expect(hero.locator('svg.animate-eye-ignite')).toBeVisible();
  });
});
