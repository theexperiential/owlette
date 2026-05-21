/**
 * Screenshot - docs machine detail view.
 *
 * Output: `web/public/docs-screens/machine-detail.png`
 * Used by: `web/content/docs/dashboard/machine-monitoring.mdx`
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { seedScreenshotFixtures } from './fixtures';
import {
  installFixedClock,
  pinAdminSiteContext,
  settleForDocsScreenshot,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1100, height: 900 } });

test('machine detail docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('monitor-single-machine');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/dashboard');

    await expect(page.getByTestId('machine-card')).toHaveCount(4);
    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: ctx.machineId! })
      .first();
    await expect(card).toBeVisible();

    await card.getByText('cpu', { exact: true }).first().click();
    const chart = page.locator('.recharts-surface').first();
    await expect(chart).toBeVisible();

    const panel = chart.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " bg-card ") and contains(concat(" ", normalize-space(@class), " "), " border-border ")][1]',
    );
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(ctx.machineId!);

    await panel.getByRole('button', { name: /ram/i }).click();
    await panel.locator('button[title^="C:"]').first().click();
    await panel.getByRole('button', { name: /^gpu$/i }).click();

    await expect(panel).toContainText(/cpu/i);
    await expect(panel).toContainText(/ram/i);
    await expect(panel).toContainText('C:');
    await expect(panel).toContainText(/gpu/i);
    await expect(panel).not.toContainText(/bienvenue/i);

    await settleForDocsScreenshot(page);
    await panel.screenshot({ path: 'public/docs-screens/machine-detail.png' });
  } finally {
    await ctx.cleanup();
  }
});
