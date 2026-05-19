/**
 * Smoke tests — the simplest possible check per role.
 *
 * If these pass, the whole scaffolding works: emulators are running, the
 * web dev server is up, global-setup seeded users + captured storageState,
 * and Playwright can boot a pre-authenticated browser context that lands
 * on /dashboard without redirecting to /login or /setup-2fa.
 *
 * Any deeper assertions belong to the per-surface specs (access-control,
 * admin, machines, etc).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';

test.describe('smoke — member', () => {
  test.use(roleState('member'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe('smoke — admin', () => {
  test.use(roleState('admin'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe('smoke — superadmin', () => {
  test.use(roleState('superadmin'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('can reach /admin/users', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/users/);
    // Scope to the heading — "user management" also appears in the sidebar nav.
    // Bumped to 10s because RequireSuperadmin renders a "verifying permissions..."
    // gate while AuthContext hydrates against the auth emulator + the role
    // lookup completes; on cold-start runs this can briefly exceed the 5s default.
    await expect(
      page.getByRole('heading', { name: 'user management' }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
