/**
 * Auth — branded password reset (forgot-password + reset-password)
 *
 * Covers the logged-out recovery flow, which is now fully branded and
 * routed through Owlette's own pipeline rather than Firebase's plain email:
 *
 *   /login → "forgot password?" → /forgot-password → enter email →
 *     POST /api/auth/forgot-password (Admin SDK mints the reset link, Resend
 *     sends a branded email) → existence-agnostic confirmation.
 *
 *   reset link → /reset-password?oobCode=… → verifyPasswordResetCode →
 *     set new password → confirmPasswordReset → /login.
 *
 * Test 1 drives the UI and asserts the route succeeds for a real account (a
 * 200 + confirmation; the route would 500 and keep the user on the form if
 * Admin link-generation failed). Test 2 mints a real oobCode the same way the
 * route does — Admin SDK against the emulator — then drives the in-app reset
 * page end-to-end and proves the new password actually authenticates.
 *
 * In E2E, RESEND_API_KEY is unset, so the route skips the Resend send but
 * still mints the code and returns 200 — exactly the contract the UI depends
 * on. The branded HTML itself is unit-tested via the email-template helpers.
 *
 * Fixture isolation: a dedicated seeded user, never the shared TEST_USERS
 * fixtures (mirrors account/password.spec.ts). afterEach restores the
 * password so reruns stay deterministic.
 */

import { test, expect } from '@playwright/test';
import { getAdminAuth, AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID } from '../../helpers/emulator';
import { seedUser, type TestUser } from '../../helpers/seed';

// Start unauthenticated — this is a logged-out recovery flow.
test.use({ storageState: { cookies: [], origins: [] } });

const RESET_USER: TestUser = {
  uid: 'password-reset-test-user',
  email: 'password-reset-test@e2e.test',
  password: 'e2e-password-reset-initial',
  role: 'member',
  sites: ['site-A'],
  displayName: 'E2E Password Reset Test',
};

test.beforeAll(async () => {
  await seedUser(RESET_USER);
});

test.afterEach(async () => {
  // Test 2 changes the password; restore the seeded baseline so the second
  // test on a warm-emulator rerun starts from a known state. Scoped to
  // RESET_USER — the shared member account is never touched.
  await getAdminAuth().updateUser(RESET_USER.uid, { password: RESET_USER.password });
});

/**
 * Sign in against the Auth emulator's REST endpoint. 200 = success,
 * 400 = auth failed (INVALID_PASSWORD / EMAIL_NOT_FOUND).
 */
async function signInStatus(email: string, password: string): Promise<number> {
  const res = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Project-Id': EMULATOR_PROJECT_ID,
      },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  return res.status;
}

test('forgot-password link triggers the branded reset route and shows the confirmation', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: /forgot password/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);

  await page.getByLabel(/email/i).fill(RESET_USER.email);
  await page.getByRole('button', { name: /send reset link/i }).click();

  // The route mints a reset link via the Admin SDK and returns 200. For a
  // SEEDED account that 200 proves generation succeeded — a failure would 500
  // and the page would stay on the form. The confirmation is existence-
  // agnostic by design.
  await expect(page.getByText(/a password reset link is on its way/i)).toBeVisible();
});

test('reset-password page consumes an oobCode and sets a new working password', async ({ page }) => {
  // Mint a real reset code exactly the way the server route does — Admin SDK
  // against the emulator — then drive the branded in-app reset page.
  const link = await getAdminAuth().generatePasswordResetLink(RESET_USER.email);
  const oobCode = new URL(link).searchParams.get('oobCode');
  expect(oobCode).toBeTruthy();

  const newPassword = `e2e-reset-${Date.now()}`;

  await page.goto(`/reset-password?oobCode=${encodeURIComponent(oobCode!)}`);

  // The page verifies the code on mount and reveals the form for the resolved
  // account (proves verifyPasswordResetCode wired to the emulator).
  await expect(page.getByText(RESET_USER.email)).toBeVisible();

  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);
  await page.getByRole('button', { name: /^reset password$/i }).click();

  // Success redirects to /login.
  await expect(page).toHaveURL(/\/login/);

  // The new password authenticates; the old one no longer does.
  expect(await signInStatus(RESET_USER.email, newPassword)).toBe(200);
  expect(await signInStatus(RESET_USER.email, RESET_USER.password)).toBe(400);
});
