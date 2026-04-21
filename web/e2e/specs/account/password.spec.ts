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
 * `afterEach` restores the member's seeded password so subsequent tests
 * and warm-emulator reruns don't break the fixture-based sign-in.
 */

import { test, expect } from '@playwright/test';
import { getAdminAuth, AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

// IMPORTANT: do NOT use roleState('member') here. A password change revokes
// the member's refresh tokens, which invalidates global-setup's cached
// storageState for every subsequent test in this file. Instead, each test
// does a fresh sign-in through the /login form — this also ensures the
// afterEach password restore actually re-establishes a working login for
// the next run of this spec.
test.use({ storageState: { cookies: [], origins: [] } });

const MEMBER = TEST_USERS.member;

test.afterEach(async () => {
  // Restore to the seeded password so subsequent runs (and global-setup
  // on the NEXT run) can still sign the member in.
  await getAdminAuth().updateUser(MEMBER.uid, { password: MEMBER.password });
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
  await signIn(page, MEMBER.email, currentPasswordForSignIn);
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  // Sidebar button labelled "security" on the left; mobile has a scrollable
  // tab bar with the same text — first() picks the visible one.
  await page.getByRole('button', { name: /^security$/i }).first().click();
  await page.getByRole('button', { name: /^update password$/i }).click();
}

test('member can change password; new password authenticates against the emulator', async ({ page }) => {
  const newPassword = `e2e-new-member-pw-${Date.now()}`;

  await openSecuritySection(page, MEMBER.password);
  await page.locator('#currentPassword').fill(MEMBER.password);
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // Success toast from updatePassword's happy path.
  await expect(page.getByText('Password Updated', { exact: true })).toBeVisible();

  // Auth emulator REST — new password works, old password doesn't.
  const newStatus = await signInStatus(MEMBER.email, newPassword);
  expect(newStatus).toBe(200);

  const oldStatus = await signInStatus(MEMBER.email, MEMBER.password);
  expect(oldStatus).toBe(400);
});

test('submitting a wrong current password surfaces "Current password is incorrect"', async ({ page }) => {
  const newPassword = `e2e-never-applied-pw-${Date.now()}`;

  await openSecuritySection(page, MEMBER.password);
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
  const oldStatus = await signInStatus(MEMBER.email, MEMBER.password);
  expect(oldStatus).toBe(200);
});
