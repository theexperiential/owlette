/**
 * Landing — pricing regression
 *
 * Locks down the two-tier pricing layout (core + pro) on the public landing
 * page. Pricing copy is high-signal — accidental edits to the per-machine /
 * per-site rates, the "free during beta" label, or the roost storage allowance
 * should break CI, not silently ship to production. The landing page is
 * public, so this spec runs without a storage state.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — pricing', () => {
  test('renders core and pro tier cards with the expected copy and CTAs', async ({ page }) => {
    await page.goto('/');

    const pricing = page.locator('section#pricing');
    await expect(pricing).toBeVisible();

    // Section header.
    await expect(
      pricing.getByRole('heading', { name: /simple, transparent pricing\./i }),
    ).toBeVisible();

    // Two tier cards — scope each by its heading.
    const coreCard = pricing.locator('div').filter({ has: page.getByRole('heading', { name: 'core', exact: true }) }).first();
    const proCard = pricing.locator('div').filter({ has: page.getByRole('heading', { name: 'pro', exact: true }) }).first();

    await expect(coreCard).toBeVisible();
    await expect(proCard).toBeVisible();

    // Core card — $10 per machine per month, free during beta.
    await expect(coreCard).toContainText('$10');
    await expect(coreCard).toContainText('/machine/month');
    await expect(coreCard).toContainText('free during beta');

    // Pro card — $40 per site per month, free during beta, roost storage copy.
    await expect(proCard).toContainText('$40');
    await expect(proCard).toContainText('/site/month');
    await expect(proCard).toContainText('free during beta');
    await expect(proCard).toContainText('roost');
    await expect(proCard).toContainText('100 GB included project storage per site');
    await expect(proCard).toContainText('$0.10/GB overage');

    // Pro card visual marker — the `new` chip is rendered inside the card,
    // and the card container carries the accent-cyan border class.
    await expect(proCard.getByText('new', { exact: true })).toBeVisible();
    await expect(proCard).toHaveClass(/border-accent-cyan\/40/);

    // Pro card prelude — "everything in core, plus:" only appears on pro.
    await expect(proCard).toContainText('everything in core, plus:');
    await expect(coreCard).not.toContainText('everything in core, plus:');

    // Both cards CTA → /register.
    await expect(coreCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(proCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
  });
});
