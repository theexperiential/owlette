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

test.describe('landing — hero', () => {
  test('hero renders', async ({ page }) => {
    await page.goto('/');

    // Headline. The accessible name flattens the inline <br> so a single
    // case-insensitive match works on both mobile and desktop layouts.
    await expect(
      page.getByRole('heading', { name: /attention is all you need/i }),
    ).toBeVisible();

    // Primary CTA → /register.
    await expect(
      page.getByRole('main').getByRole('link', { name: 'get started', exact: true }),
    ).toHaveAttribute('href', '/register');

    // Secondary CTA → /demo.
    await expect(
      page.getByRole('main').getByRole('link', { name: 'see the live demo', exact: true }),
    ).toHaveAttribute('href', '/demo');

    // Platform pill row — substring matches so casing/punctuation tweaks
    // around the middots don't false-positive this regression.
    const pillRow = page.getByRole('main').locator('p', { hasText: 'windows only' });
    await expect(pillRow).toBeVisible();
    await expect(pillRow).toContainText('windows only');
    await expect(pillRow).toContainText('free during beta');
    await expect(pillRow).toContainText('FSL-1.1');

    // Rotator subhead — the initial prefix word ('monitor') is rendered
    // before any cycling kicks in. Asserting a single stable word keeps
    // this regression deterministic without testing animation timing.
    await expect(page.getByRole('main').getByText('monitor', { exact: true })).toBeVisible();

    // Owl eye SVG — animated eye carries the `animate-eye-ignite` class.
    await expect(page.locator('svg.animate-eye-ignite')).toBeVisible();
  });
});
