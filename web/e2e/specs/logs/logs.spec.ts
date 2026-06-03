import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedLogEvents } from '../../helpers/coverageSeed';

test.use(roleState('superadmin'));

test.beforeEach(async () => {
  await seedLogEvents('site-A');
});

async function gotoSiteALogs(page: Page) {
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

  const siteSwitcher = page.getByTestId('site-switcher-trigger');
  await expect(siteSwitcher).toBeVisible();
  if (!((await siteSwitcher.textContent()) ?? '').includes('Site A')) {
    await siteSwitcher.click();
    await page.getByRole('menuitem', { name: /Site A \(Assigned\)/ }).click();
    await expect(siteSwitcher).toContainText('Site A');
  }
}

test('filters by action, machine, level, and custom date; reset restores rows', async ({ page }) => {
  await gotoSiteALogs(page);
  await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /show filters/i }).click();

  await page.getByTestId('logs-filter-level').click();
  await page.getByRole('option', { name: 'warning' }).click();
  await expect(page.getByText(/deployment failed/i)).toBeVisible();
  await expect(page.getByText('agent started', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /reset filters/i }).click();
  await expect(page.getByText('agent started', { exact: true })).toBeVisible();

  await page.getByTestId('logs-filter-machine').click();
  await page.getByRole('option', { name: 'e2e-logs-alt' }).click();
  await expect(page.getByText('agent started', { exact: true })).toBeVisible();
  await expect(page.getByText('TouchDesigner', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /reset filters/i }).click();
  await page.getByTestId('logs-filter-action').click();
  await page.getByRole('option', { name: /scheduled restart/i }).click();
  await expect(page.getByText(/no logs found for this site/i)).toBeVisible();

  await page.getByRole('button', { name: /reset filters/i }).click();
  await page.getByTestId('logs-filter-date').click();
  await page.getByRole('option', { name: /custom range/i }).click();
  // Native <input type="date"> was replaced by the themed DatePicker (text input
  // + calendar popover); assert the two typed-entry fields by their placeholders.
  await expect(page.getByPlaceholder('start date')).toBeVisible();
  await expect(page.getByPlaceholder('end date')).toBeVisible();
});

test('expands rows, expands all, and opens the screenshot modal', async ({ page }) => {
  await gotoSiteALogs(page);
  await expect(page.getByTestId('log-row-e2e-log-crash')).toBeVisible();

  await page.getByTestId('log-row-e2e-log-crash').click();
  await expect(page.getByText(/TouchDesigner crashed with exit code 1/i)).toBeVisible();
  await page.getByAltText(/crash screenshot/i).first().click();
  await expect(page.getByAltText(/crash screenshot/i).last()).toBeVisible();
  await page.mouse.click(10, 10);

  await page.getByTestId('logs-expand-all').click();
  await expect(page.getByText(/Installer returned retryable warning/i)).toBeVisible();
  await page.getByTestId('logs-expand-all').click();
  await expect(page.getByText(/Installer returned retryable warning/i)).toHaveCount(1);
});

test('clear filtered logs removes only matching rows', async ({ page }) => {
  await gotoSiteALogs(page);
  await page.getByRole('button', { name: /show filters/i }).click();
  await page.getByTestId('logs-filter-level').click();
  await page.getByRole('option', { name: 'warning' }).click();

  await page.getByRole('button', { name: /clear logs/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /clear logs/i }).click();

  await expect(page.getByText(/no logs found for this site/i)).toBeVisible();
  const remaining = await getAdminDb()
    .collection('sites')
    .doc('site-A')
    .collection('logs')
    .get();
  expect(remaining.docs.map((doc) => doc.id).sort()).toEqual(['e2e-log-crash', 'e2e-log-info']);
});
