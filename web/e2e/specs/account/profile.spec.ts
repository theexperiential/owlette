/**
 * Account — edit profile. displayName goes through Firebase Auth's
 * `updateProfile()`, NOT Firestore, so the read-through asserts against
 * `admin.auth().getUser(uid).displayName`.
 *
 * Member role: the flow is self-service, nothing here is role-gated.
 * `afterEach` restores the seeded displayName so a warm emulator does not
 * carry a mutated auth record into later runs.
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

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();

  // The dialog's accessible name is VisuallyHidden — target the heading.
  await expect(page.getByRole('heading', { name: 'profile', exact: true })).toBeVisible();

  const firstInput = page.locator('#settings-firstName');
  const lastInput = page.locator('#settings-lastName');
  await firstInput.fill(firstName);
  await lastInput.fill(lastName);

  await page.getByRole('button', { name: /^save changes$/i }).click();

  await expect(page.getByText('Profile Updated', { exact: true })).toBeVisible();

  const record = await getAdminAuth().getUser(MEMBER.uid);
  expect(record.displayName).toBe(expectedDisplayName);
});

test('clearing both name fields shows an error toast and skips the write', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await expect(page.getByRole('heading', { name: 'profile', exact: true })).toBeVisible();

  // Blanking BOTH fields skips updateUserProfile entirely (it needs
  // `firstName || lastName`), which reads as a silent success. A single space
  // forces the handler and its validation toast.
  await page.locator('#settings-firstName').fill(' ');
  await page.locator('#settings-lastName').fill('');

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // AuthContext toasts "Update Failed" twice here (inner validation + outer
  // catch), so assert on the first rather than tripping strict mode.
  await expect(page.getByText('Update Failed', { exact: true }).first()).toBeVisible();

  const record = await getAdminAuth().getUser(MEMBER.uid);
  expect(record.displayName).toBe(MEMBER.displayName);
});
