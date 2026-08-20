/**
 * Auth — signup. Asserts the new user's Firestore doc under the three-role
 * model: role 'member' (NOT the retired 'user'), requiresMfaSetup true, sites
 * empty — and that signup redirects to /setup-2fa, not /dashboard.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';

// Fresh context — no storageState, so the browser starts unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

test('new signup writes role: member and redirects to /setup-2fa', async ({ page }) => {
  // Unique per run so re-runs cannot collide with seeded users, even though
  // global-setup resets the emulator.
  const stamp = Date.now();
  const email = `new-signup-${stamp}@e2e.test`;
  const password = 'e2e-new-signup-password';

  await page.goto('/register');

  // Email FIRST: the form is progressive — name and password only mount once
  // email is focused, so filling any other field first would time out.
  await page.getByLabel(/^email$/i).fill(email);

  await page.getByLabel(/first name/i).fill('E2E');
  await page.getByLabel(/last name/i).fill('Signup');
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByLabel(/confirm password/i).fill(password);

  // "i agree to the terms ..." checkbox (if present on the form).
  const termsCheckbox = page.getByLabel(/terms/i).first();
  if (await termsCheckbox.isVisible().catch(() => false)) {
    await termsCheckbox.check();
  }

  await page.getByRole('button', { name: /create account|sign up|register/i }).first().click();

  // Either URL proves the MFA gate fired: session-cookie timing can bounce the
  // user through /login?redirect=/setup-2fa first. Accepting both avoids
  // flaking on the createSessionCookie/navigation race.
  await expect(page).toHaveURL(/\/setup-2fa|\/login\?redirect=%2Fsetup-2fa/, {
    timeout: 20_000,
  });

  // The real assertion: new code MUST write 'member' directly, not rely on the
  // permission-model-split migration to re-flip a legacy 'user'.
  const db = getAdminDb();
  const authAdmin = (await import('firebase-admin')).default.auth();
  const userRecord = await authAdmin.getUserByEmail(email);
  const userDoc = await db.collection('users').doc(userRecord.uid).get();
  expect(userDoc.exists).toBe(true);
  const data = userDoc.data()!;
  expect(data.role).toBe('member');
  expect(data.requiresMfaSetup).toBe(true);
  expect(data.sites).toEqual([]);
});
