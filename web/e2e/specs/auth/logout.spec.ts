/**
 * Auth — logout flow. "Sign out" must destroy the session cookie and Firebase
 * client auth state, redirect away, and force re-auth on protected routes.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const E2E_PORT = Number(process.env.E2E_PORT) || 3100;
const signedOutUrlPattern = new RegExp(`^http://127\\.0\\.0\\.1:${E2E_PORT}/(login)?$`);

test.describe('logout — member', () => {
  test.use(roleState('member'));

  test('clicking sign out exits the authenticated surface and invalidates session', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);

    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();

    // Landing page or /login both count as signed out — the redirect target
    // isn't load-bearing, leaving the authenticated surface is.
    await expect(page).toHaveURL(signedOutUrlPattern, {
      timeout: 10_000,
    });

    // A protected route without re-auth must bounce to login.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
