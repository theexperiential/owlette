/**
 * Mobile — auth (login + register). Viewport / isMobile / hasTouch come from the
 * `mobile-chromium` project, which owns every spec under specs/mobile/**.
 *
 * responsive-acceptance.spec.ts measures both forms expanded; this drives them:
 * a real email sign-in landing on /dashboard, and register's inline validation.
 * Both are progressive forms whose fields mount only after email takes focus.
 *
 * Isolation: sign-in mints a dedicated user per run (never `TEST_USERS.member`,
 * whose token state is shared by every role fixture — see e2e/README.md), and
 * the register test stops at client-side validation, so no account is created.
 */

import { test, expect } from '@playwright/test';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';

// Unauthenticated — these routes redirect a signed-in visitor away.
test.use({ storageState: { cookies: [], origins: [] } });

test('email sign-in completes from the mobile login form', async ({ page }) => {
  const user = await seedDedicatedUser(dedicatedUser('member', `mobile-login-${Date.now()}`));

  await page.goto('/login');

  // Progressive form: password + submit mount on email focus, and `fill()` focuses.
  await expect(page.getByRole('button', { name: /continue with Google/i })).toBeVisible();
  await page.getByLabel(/^email$/i).fill(user.email);

  const password = page.getByLabel(/^password$/i);
  await expect(password).toBeVisible();
  await password.fill(user.password);
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: /sign in with email/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 20_000 });
  await assertNoHorizontalOverflow(page);
});

test('register surfaces inline validation without leaving the viewport', async ({ page }) => {
  await page.goto('/register');

  // Same progressive reveal as login.
  await page.getByLabel(/^email$/i).fill(`mobile-register-${Date.now()}@e2e.test`);
  await expect(page.getByLabel(/first name/i)).toBeVisible();

  await page.getByLabel(/first name/i).fill('E2E');
  await page.getByLabel(/last name/i).fill('Mobile');
  await page.getByLabel(/^password$/i).fill('e2e-mobile-register-password');
  await page.getByLabel(/confirm password/i).fill('e2e-mobile-different-password');
  await page.getByLabel(/terms/i).first().check();
  await assertNoHorizontalOverflow(page);

  // Submit stays disabled until Turnstile returns a token (test keys self-solve).
  const submit = page.getByRole('button', { name: /create account/i });
  await expect(submit).toBeEnabled({ timeout: 20_000 });

  // Mismatch is caught client-side — no account, and the Turnstile token is unspent.
  await submit.click();
  await expect(page.getByText('passwords do not match')).toBeVisible();

  await assertNoHorizontalOverflow(page);
});
