/**
 * Access-control — PageHeader (top-bar user menu)
 *
 * Verifies role-conditional chrome on every authenticated page:
 *   - the red "superadmin" Crown pill next to the avatar, visible only for
 *     role === 'superadmin'
 *   - the "admin panel" link inside the user-menu dropdown, visible only for
 *     role === 'superadmin'
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';

async function openUserMenu(page: Page) {
  await page.getByTestId('user-menu-trigger').click();
}

test.describe('PageHeader — member', () => {
  test.use(roleState('member'));

  test('does not show superadmin Crown pill', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toHaveCount(0);
  });

  test('does not show admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toHaveCount(0);
  });
});

test.describe('PageHeader — admin (site-scoped middle tier)', () => {
  test.use(roleState('admin'));

  test('does not show superadmin Crown pill', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toHaveCount(0);
  });

  test('does not show admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toHaveCount(0);
  });
});

test.describe('PageHeader — superadmin (platform god-mode)', () => {
  test.use(roleState('superadmin'));

  test('shows red superadmin Crown pill next to avatar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toBeVisible();
  });

  test('shows admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toBeVisible();
  });
});
