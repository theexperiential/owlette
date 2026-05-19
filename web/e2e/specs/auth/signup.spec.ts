/**
 * Auth — signup flow
 *
 * Verifies that a brand-new user can complete the email/password registration,
 * and that the resulting Firestore user doc has the expected shape under the
 * three-role permission model:
 *
 *   - role: 'member' (NOT 'user' — that value is retired as of the permission
 *     model split; new users must default to the new vocabulary)
 *   - requiresMfaSetup: true (the mandatory-2FA gate for new signups)
 *   - sites: [] (member starts unassigned; superadmins assign sites manually)
 *
 * Also asserts the post-signup redirect lands on /setup-2fa (the mandatory
 * 2FA setup page), NOT /dashboard.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';

// Fresh context — no storageState, so the browser starts unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

test('new signup writes role: member and redirects to /setup-2fa', async ({ page }) => {
  // Unique identifier per run so re-runs don't collide against the seeded users.
  // global-setup resets the emulator between runs, but the test runner may
  // invoke `test.describe.configure({ mode: 'serial' })` with shared state in
  // the future — uniqueness keeps us safe either way.
  const stamp = Date.now();
  const email = `new-signup-${stamp}@e2e.test`;
  const password = 'e2e-new-signup-password';

  await page.goto('/register');

  await page.getByLabel(/first name/i).fill('E2E');
  await page.getByLabel(/last name/i).fill('Signup');
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByLabel(/confirm password/i).fill(password);

  // "i agree to the terms ..." checkbox (if present on the form).
  const termsCheckbox = page.getByLabel(/terms/i).first();
  if (await termsCheckbox.isVisible().catch(() => false)) {
    await termsCheckbox.check();
  }

  await page.getByRole('button', { name: /create account|sign up|register/i }).first().click();

  // New signups target /setup-2fa (the mandatory MFA gate). Depending on
  // session-cookie timing, the user may bounce through /login?redirect=/setup-2fa
  // before landing — both URLs are valid evidence that the MFA gate fired.
  // We intentionally accept either to avoid flaking on the session-cookie race
  // between createSessionCookie (POST /api/auth/session) and the next navigation.
  await expect(page).toHaveURL(/\/setup-2fa|\/login\?redirect=%2Fsetup-2fa/, {
    timeout: 20_000,
  });

  // Admin SDK read-through: the signup flow wrote the user doc with the new
  // three-role vocabulary. If role lands as 'user' (old vocabulary) the
  // permission-model-split migration script would re-flip it, but new code
  // MUST write 'member' directly per wave 0.1.3. This is the real assertion —
  // the URL above just pins the MFA gate fired; the doc shape below pins the
  // role-default contract.
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
