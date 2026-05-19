import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { clearSystemPreset, seedSystemPreset } from '../../helpers/coverageSeed';

test.use(roleState('superadmin'));

test.beforeEach(async () => {
  await seedSystemPreset('e2e-system-preset');
});

test.afterEach(async () => {
  await clearSystemPreset('e2e-system-preset');
});

test('superadmin can list, filter, create, edit, and delete system presets', async ({ page }) => {
  await page.goto('/admin/presets');
  await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
  await expect(page.getByText('E2E Template 1.0').first()).toBeVisible();

  await page.getByRole('button', { name: /utilities/i }).click();
  await expect(page.getByText('E2E Template', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /edit E2E Template 1.0/i }).first().click();
  await page.locator('#name').fill('E2E Template 1.1');
  await page.getByRole('button', { name: /update template/i }).click();
  await expect(page.getByText('E2E Template 1.1').first()).toBeVisible();

  await page.getByRole('button', { name: /add template/i }).click();
  await page.locator('#name').fill('E2E Created Template');
  await page.locator('#softwareName').fill('E2E Created');
  await page.getByText('select a category...').click();
  await page.getByRole('option', { name: /utilities/i }).click();
  await page.locator('#installerName').fill('e2e-created.exe');
  await page.locator('#installerUrl').fill('https://example.test/e2e-created.exe');
  await page.locator('#silentFlags').fill('/S');
  await page.getByRole('button', { name: /create template/i }).click();
  await expect(page.getByText('E2E Created Template').first()).toBeVisible();

  await page.getByRole('button', { name: /delete E2E Template 1.1/i }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /delete preset/i }).click();
  await expect(page.getByRole('button', { name: /delete E2E Template 1.1/i })).toHaveCount(0);

  await page.getByRole('button', { name: /delete E2E Created Template/i }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /delete preset/i }).click();
  await expect(page.getByRole('button', { name: /delete E2E Created Template/i })).toHaveCount(0);
});
