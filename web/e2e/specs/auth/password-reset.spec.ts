/**
 * Auth — branded password reset, the logged-out recovery flow through Owlette's own pipeline
 * rather than Firebase's plain email:
 *   /login → "forgot password?" → /forgot-password → POST /api/auth/forgot-password (Admin
 *     SDK mints the link, Resend sends it) → existence-agnostic confirmation
 *   reset link → /reset-password?oobCode=… → verifyPasswordResetCode → confirmPasswordReset
 *
 * Test 1 drives the UI on a real account; the route would 500 and stay on the form if Admin
 * link-generation failed. Test 2 mints an oobCode the same way the route does and proves the
 * new password authenticates.
 *
 * RESEND_API_KEY is unset in e2e, so the route skips the send but still mints the code and
 * returns 200 — the contract the UI depends on. Branded HTML is unit-tested separately.
 *
 * Isolation: a dedicated seeded user, never the shared TEST_USERS; afterEach restores the
 * password so reruns are deterministic.
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
  // Restore the seeded baseline so a warm-emulator rerun starts known. RESET_USER only.
  await getAdminAuth().updateUser(RESET_USER.uid, { password: RESET_USER.password });
});

/** Auth-emulator REST sign-in: 200 = success, 400 = INVALID_PASSWORD / EMAIL_NOT_FOUND. */
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
  // "forgot password?" sits in the always-visible footer band, not inside the progressive
  // email form — recovery stays one click away for a user who cannot get in.
  await page.getByRole('link', { name: /forgot password/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);

  await page.getByLabel(/email/i).fill(RESET_USER.email);
  await page.getByRole('button', { name: /send reset link/i }).click();

  // On a seeded account the 200 proves Admin link-generation succeeded; a failure would 500
  // and stay on the form. The confirmation copy is existence-agnostic by design.
  await expect(page.getByText(/a password reset link is on its way/i)).toBeVisible();
});

test('reset-password page consumes an oobCode and sets a new working password', async ({ page }) => {
  // Mint the code the way the route does (Admin SDK against the emulator), then drive the
  // in-app reset page.
  const link = await getAdminAuth().generatePasswordResetLink(RESET_USER.email);
  const oobCode = new URL(link).searchParams.get('oobCode');
  expect(oobCode).toBeTruthy();

  const newPassword = `e2e-reset-${Date.now()}`;

  await page.goto(`/reset-password?oobCode=${encodeURIComponent(oobCode!)}`);

  // The form only appears once verifyPasswordResetCode resolves against the emulator.
  await expect(page.getByText(RESET_USER.email)).toBeVisible();

  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);
  await page.getByRole('button', { name: /^reset password$/i }).click();

  await expect(page).toHaveURL(/\/login/);

  // The new password authenticates; the old one no longer does.
  expect(await signInStatus(RESET_USER.email, newPassword)).toBe(200);
  expect(await signInStatus(RESET_USER.email, RESET_USER.password)).toBe(400);
});
