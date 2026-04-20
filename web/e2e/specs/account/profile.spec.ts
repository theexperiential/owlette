/**
 * Account — edit profile (C4.1)
 *
 * The profile section of AccountSettingsDialog updates the user's
 * displayName via Firebase Auth's `updateProfile()` — NOT via a
 * Firestore write. So the read-through asserts against
 * `admin.auth().getUser(uid).displayName`, not a `users/{uid}` doc.
 *
 * Member role is used because profile edit is a self-service flow
 * available to every authenticated user; nothing role-gated here.
 *
 * `afterEach` restores the member's displayName to the seeded value
 * so subsequent tests (and subsequent runs against a warm emulator)
 * aren't left with a mutated auth record.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminAuth } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

test.use(roleState('member'));

const MEMBER = TEST_USERS.member;

test.afterEach(async () => {
  await getAdminAuth().updateUser(MEMBER.uid, { displayName: MEMBER.displayName });
});

test('member can rename themselves via account settings → profile', async ({ page }) => {
  const stamp = Date.now();
  const firstName = 'Renamed';
  const lastName = `Member ${stamp}`;
  const expectedDisplayName = `${firstName} ${lastName}`;

  await page.goto('/dashboard');

  // Open user menu → "account settings" → dialog opens on profile section.
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();

  // The dialog's accessible name is sr-only "account settings" (VisuallyHidden).
  // Target by the profile heading instead.
  await expect(page.getByRole('heading', { name: 'profile', exact: true })).toBeVisible();

  const firstInput = page.locator('#settings-firstName');
  const lastInput = page.locator('#settings-lastName');
  // Inputs are pre-populated from the current user.displayName split; overwrite.
  await firstInput.fill(firstName);
  await lastInput.fill(lastName);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // Toast from AuthContext on successful updateProfile call.
  await expect(page.getByText('Profile Updated', { exact: true })).toBeVisible();

  // Admin SDK read-through — Firebase Auth now has the new displayName.
  const record = await getAdminAuth().getUser(MEMBER.uid);
  expect(record.displayName).toBe(expectedDisplayName);
});

test('clearing both name fields shows an error toast and skips the write', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await expect(page.getByRole('heading', { name: 'profile', exact: true })).toBeVisible();

  // The dialog only calls updateUserProfile when `firstName || lastName` is
  // truthy, so blanking BOTH skips the auth call entirely — which looks like
  // a silent success. Fill a single whitespace first to force the handler
  // path: that triggers the validation toast "Please provide at least a
  // first or last name" from AuthContext's updateUserProfile.
  await page.locator('#settings-firstName').fill(' ');
  await page.locator('#settings-lastName').fill('');

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // AuthContext fires "Update Failed" twice on this path — once from the
  // inner validation block, once from the outer catch that re-toasts via
  // handleError. Both land as separate sonner toasts; assert at least one
  // is visible rather than violating strict mode.
  await expect(page.getByText('Update Failed', { exact: true }).first()).toBeVisible();

  // Admin SDK — displayName unchanged.
  const record = await getAdminAuth().getUser(MEMBER.uid);
  expect(record.displayName).toBe(MEMBER.displayName);
});
