/**
 * Account — change password (C4.2)
 *
 * The password-change flow lives in AccountSettingsDialog's "security"
 * section, behind an "update password" toggle. On save, AuthContext's
 * `updatePassword` re-authenticates via `EmailAuthProvider.credential(...)`
 * then calls Firebase's `updatePassword(user, newPassword)`.
 *
 * This spec covers:
 *   - happy path — rename current → new → confirm → save → toast
 *     "Password Updated" + emulator REST sign-in with the NEW password
 *     succeeds (load-bearing read-through: firebase-admin.UserRecord
 *     has no password-update timestamp, so we prove the change by
 *     actually signing in)
 *   - wrong-current-password edge — re-auth fails with
 *     'auth/wrong-password' or 'auth/invalid-credential' → AuthContext
 *     surfaces "Current password is incorrect." toast
 *
 * IMPORTANT — fixture-isolation rule (why we use a dedicated user):
 *
 *   Firebase revokes ALL refresh tokens for a user when their password
 *   changes — not just the session that triggered the change. Using the
 *   shared `TEST_USERS.member` fixture here would leave the
 *   `fixtures/member.json` storageState (captured once in global-setup)
 *   holding dead refresh tokens for every downstream member-scoped
 *   spec in the run. `afterEach` could restore the PASSWORD but not
 *   the revoked tokens — the client-side IDB state is what global-setup
 *   captured, and Firebase won't reissue against a revoked refresh
 *   chain. The result was six cascading failures in
 *   account/preferences.spec.ts, account/profile.spec.ts,
 *   auth/logout.spec.ts, and sites/access-defaults.spec.ts — all
 *   timing out on `user-menu-trigger` / `site-switcher-trigger`
 *   because the dashboard could never render a signed-in shell.
 *
 *   Fix: seed a dedicated `password-test-user` in beforeAll and scope
 *   every mutation to it. The shared member fixture is never touched,
 *   and this spec's tests stay internally idempotent via afterEach.
 */

import { test, expect } from '@playwright/test';
import { getAdminAuth, AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID } from '../../helpers/emulator';
import { seedUser, type TestUser } from '../../helpers/seed';

// Do NOT use roleState here. See header comment for the fixture-isolation
// rationale. Each test signs in fresh through the /login form.
test.use({ storageState: { cookies: [], origins: [] } });

const PW_USER: TestUser = {
  uid: 'password-test-user',
  email: 'password-test@e2e.test',
  password: 'e2e-password-test-initial',
  role: 'member',
  sites: ['site-A'],
  displayName: 'E2E Password Test',
};

test.beforeAll(async () => {
  // Idempotent — re-seeding on warm emulators resets the password so
  // previous-run mutations don't poison the first test here.
  await seedUser(PW_USER);
});

test.afterEach(async () => {
  // Restore to the seeded password so the second test in this file (and
  // the happy-path test on warm-emulator reruns) starts from a known
  // baseline. Scoped to PW_USER — the shared member account is not
  // touched.
  await getAdminAuth().updateUser(PW_USER.uid, { password: PW_USER.password });
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await page.waitForURL(/\/dashboard|\/setup-2fa|\/verify-2fa/, { timeout: 15_000 });
}

/**
 * Sign in against the Auth emulator's REST endpoint with an explicit
 * password. Returns the HTTP status — 200 is a successful sign-in,
 * 400 is the auth-failed case (INVALID_PASSWORD / EMAIL_NOT_FOUND).
 */
async function signInStatus(email: string, password: string): Promise<number> {
  const url =
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` +
    `?key=demo-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Auth emulator requires a project-id hint on REST calls.
      'X-Goog-Project-Id': EMULATOR_PROJECT_ID,
    },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return res.status;
}

async function openSecuritySection(
  page: import('@playwright/test').Page,
  currentPasswordForSignIn: string,
) {
  await signIn(page, PW_USER.email, currentPasswordForSignIn);
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  // Sidebar button labelled "security" on the left; mobile has a scrollable
  // tab bar with the same text — first() picks the visible one.
  await page.getByRole('button', { name: /^security$/i }).first().click();
  await page.getByRole('button', { name: /^update password$/i }).click();
}

test('user can change password; new password authenticates against the emulator', async ({ page }) => {
  const newPassword = `e2e-new-pw-${Date.now()}`;

  await openSecuritySection(page, PW_USER.password);
  await page.locator('#currentPassword').fill(PW_USER.password);
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // Success toast from updatePassword's happy path.
  await expect(page.getByText('Password Updated', { exact: true })).toBeVisible();

  // Auth emulator REST — new password works, old password doesn't.
  const newStatus = await signInStatus(PW_USER.email, newPassword);
  expect(newStatus).toBe(200);

  const oldStatus = await signInStatus(PW_USER.email, PW_USER.password);
  expect(oldStatus).toBe(400);
});

test('submitting a wrong current password surfaces "Current password is incorrect"', async ({ page }) => {
  const newPassword = `e2e-never-applied-pw-${Date.now()}`;

  await openSecuritySection(page, PW_USER.password);
  await page.locator('#currentPassword').fill('definitely-the-wrong-password');
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // AuthContext's specific 'auth/wrong-password' / 'auth/invalid-credential'
  // branch fires a toast with description "Current password is incorrect."
  await expect(
    page.getByText('Current password is incorrect.', { exact: true }),
  ).toBeVisible();

  // Seeded password still works — the save never went through.
  const oldStatus = await signInStatus(PW_USER.email, PW_USER.password);
  expect(oldStatus).toBe(200);
});
