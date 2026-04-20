/**
 * Access-control — route guards
 *
 * RequireSuperadmin wraps /admin/layout.tsx. Anyone without role ===
 * 'superadmin' should get redirected to /dashboard with an error toast.
 * Unauthenticated users should hit /login instead.
 *
 * These tests assert URL behavior, not DOM content — the guard runs in a
 * useEffect, so we wait for the router.push to settle before asserting.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const ADMIN_ROUTES = [
  '/admin/users',
  '/admin/installers',
  '/admin/webhooks',
  '/admin/alerts',
  '/admin/tokens',
  '/admin/schedules',
  '/admin/email',
];

test.describe('route guards — unauthenticated', () => {
  // Fresh context: no storageState → no auth.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('visiting /dashboard redirects to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('visiting /admin/users redirects to /login', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

test.describe('route guards — member', () => {
  test.use(roleState('member'));

  for (const route of ADMIN_ROUTES) {
    test(`visiting ${route} redirects away`, async ({ page }) => {
      await page.goto(route);
      // RequireSuperadmin fires in a useEffect → allow time for the router.push.
      await expect(page).not.toHaveURL(new RegExp(`${route}$`), { timeout: 10_000 });
    });
  }
});

test.describe('route guards — admin (site-scoped, NOT platform)', () => {
  test.use(roleState('admin'));

  test('visiting /admin/users redirects away (admins are site-scoped)', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).not.toHaveURL(/\/admin\/users/, { timeout: 10_000 });
  });

  test('visiting /admin/installers redirects away', async ({ page }) => {
    await page.goto('/admin/installers');
    await expect(page).not.toHaveURL(/\/admin\/installers/, { timeout: 10_000 });
  });
});

test.describe('route guards — superadmin', () => {
  test.use(roleState('superadmin'));

  for (const route of ADMIN_ROUTES) {
    test(`can reach ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
    });
  }
});
