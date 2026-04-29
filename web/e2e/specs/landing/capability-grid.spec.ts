import { test, expect } from '@playwright/test';

// Public landing page — no auth required.
test.use({ storageState: { cookies: [], origins: [] } });

const CAPABILITY_LABELS = ['monitor', 'control', 'deploy', 'display', 'diagnose', 'automate'] as const;

test.describe('landing capability grid', () => {
  test('renders all six capability cards in a 3-column desktop grid', async ({ page }) => {
    await page.goto('/');

    // Desktop variant — UseCaseSection renders both a mobile accordion
    // (lg:hidden) and a desktop grid (hidden lg:block). Playwright's
    // Desktop Chrome viewport (1280px) puts us in the lg breakpoint, so
    // scope to the desktop block to avoid matching the mobile duplicates.
    const desktop = page.locator('div.hidden.lg\\:block').first();
    await expect(desktop).toBeVisible();

    const grid = desktop.locator('div.grid.grid-cols-3').first();
    await expect(grid).toBeVisible();

    for (const label of CAPABILITY_LABELS) {
      await expect(grid.getByRole('heading', { name: label, level: 3 })).toBeVisible();
    }
  });

  test('clicking a card reveals its expanded description', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();
    // The "monitor" card's expanded copy is unique enough to assert against.
    const expandedSnippet = /live cpu, memory, gpu, and disk usage/i;
    await expect(desktop.getByText(expandedSnippet)).toHaveCount(0);

    await desktop.getByRole('button', { name: /^monitor/i }).click();
    await expect(desktop.getByText(expandedSnippet)).toBeVisible();
  });

  test('clicking a preview opens the lightbox and Escape closes it', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();

    // Open a card so the shared preview area appears below the grid.
    await desktop.getByRole('button', { name: /^monitor/i }).click();

    // Click the preview image to launch the lightbox overlay.
    await desktop.locator('img[alt="monitor preview"]').click();

    // Lightbox is a fixed full-screen overlay outside the desktop block.
    const lightbox = page.locator('div.fixed.inset-0.z-\\[100\\]');
    await expect(lightbox).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });
});
