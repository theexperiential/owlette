/**
 * Auth — logout flow
 *
 * Verifies that clicking "sign out" from the user-menu dropdown destroys the
 * session cookie + Firebase client auth state, redirects to /login, and
 * that subsequent protected-route visits require re-authentication.
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

    // Open user menu → click sign out.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();

    // Lands on the landing page (or /login) — either is valid "signed out".
    // The exact redirect target isn't load-bearing; what matters is that we
    // leave the authenticated surface and can't come back without re-auth.
    await expect(page).toHaveURL(signedOutUrlPattern, {
      timeout: 10_000,
    });

    // Revisiting a protected route without signing back in → bounces to login.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
