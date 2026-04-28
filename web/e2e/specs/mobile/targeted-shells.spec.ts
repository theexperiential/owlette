import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_USERS, seedMachine } from '../../helpers/seed';
import {
  seedCortexFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

test.describe('mobile authenticated shells', () => {
  test.use({
    ...roleState('admin'),
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });

  test('dashboard list controls render without clipping', async ({ page }) => {
    await seedMachine('site-A', 'e2e-mobile-machine');
    await page.goto('/dashboard');
    await expect(page.getByText('e2e-mobile-machine')).toBeVisible();
  });

  test('logs mobile filters and rows render', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await page.getByRole('button', { name: /show filters/i }).click();
    await expect(page.getByTestId('logs-filter-level')).toBeVisible();
    await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();
  });

  test('cortex mobile target selector and input render', async ({ page }) => {
    await seedCortexFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/cortex');
    await expect(page.getByLabel(/cortex target/i)).toBeVisible();
    await expect(page.getByPlaceholder(/ask about this machine/i)).toBeVisible();
  });
});

test.describe('mobile superadmin shells', () => {
  test.use({
    ...roleState('superadmin'),
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });

  test('admin sidebar route and presets mobile cards render', async ({ page }) => {
    await seedSystemPreset('e2e-mobile-system-preset', { name: 'E2E Mobile Template' });
    await page.goto('/admin/presets');
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /edit E2E Mobile Template/i }).first()).toBeVisible();
  });
});
