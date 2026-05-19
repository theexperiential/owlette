import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  seedCortexFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

async function expectNonBlankScreenshot(page: Page) {
  const shot = await page.screenshot({
    animations: 'disabled',
    fullPage: false,
    mask: [page.locator('[data-radix-popper-content-wrapper]')],
  });
  expect(shot.length).toBeGreaterThan(5_000);
}

test.describe('public visual smoke', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const route of ['/', '/privacy', '/terms', '/legal/dmca', '/demo']) {
    test(`${route} captures a nonblank desktop screenshot`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('body')).toBeVisible();
      await expectNonBlankScreenshot(page);
    });
  }
});

test.describe('authenticated visual smoke', () => {
  test.use(roleState('admin'));

  test('logs captures a nonblank desktop screenshot with seeded rows', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await expectNonBlankScreenshot(page);
  });

  test('cortex captures a nonblank desktop screenshot with seeded conversations', async ({ page }) => {
    await seedCortexFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/cortex');
    await expect(page.getByText('Deployment triage')).toBeVisible();
    await expectNonBlankScreenshot(page);
  });
});

test.describe('superadmin visual smoke', () => {
  test.use(roleState('superadmin'));

  test('admin presets captures a nonblank desktop screenshot', async ({ page }) => {
    await seedSystemPreset('e2e-visual-system-preset', { name: 'E2E Visual Template' });
    await page.goto('/admin/presets');
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
    await expectNonBlankScreenshot(page);
  });
});
