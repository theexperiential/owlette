import { test, expect } from '@playwright/test';

// Public landing page — no auth required.
test.use({ storageState: { cookies: [], origins: [] } });

const CAPABILITY_ROWS = [
  ['monitor', 'control', 'deploy'],
  ['diagnose', 'display', 'automate'],
] as const;

test.describe('landing capability grid', () => {
  test('renders all six capability cards in a 3-column desktop grid', async ({ page }) => {
    await page.goto('/');

    // Desktop variant — UseCaseSection renders both a mobile accordion
    // (lg:hidden) and a desktop grid (hidden lg:block). Playwright's
    // Desktop Chrome viewport (1280px) puts us in the lg breakpoint, so
    // scope to the desktop block to avoid matching the mobile duplicates.
    const desktop = page.locator('div.hidden.lg\\:block').first();
    await expect(desktop).toBeVisible();

    const rows = desktop.locator('.grid.grid-cols-3.gap-6.items-start');
    await expect(rows).toHaveCount(2);

    for (const [rowIndex, labels] of CAPABILITY_ROWS.entries()) {
      await expect(rows.nth(rowIndex).getByRole('heading', { level: 3 })).toHaveText(labels);
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

    // Wait for the monitor preview to fade in (rowHasActive transitions
    // the wrapper from max-h-0/opacity-0 to max-h-[800px]/opacity-100
    // over 500ms).
    const monitorImg = desktop.locator('img[alt="monitor preview"]');
    await expect(monitorImg).toBeVisible();

    // Click the image with force:true. Without it, the row's other preview
    // images (deploy, control) — which are absolutely positioned at the
    // same coordinates with opacity 0 — intercept pointer events because
    // they're later siblings in the DOM. The onClick handler is on the
    // shared cursor-zoom-in wrapper, so any click inside the stack opens
    // the lightbox at openIndex regardless of which image actually receives
    // the event.
    await monitorImg.click({ force: true });

    // Lightbox is a fixed full-screen overlay outside the desktop block.
    const lightbox = page.locator('div.fixed.inset-0.z-\\[100\\]');
    await expect(lightbox).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });
});
