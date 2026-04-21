/**
 * Account — user preferences (C4.4)
 *
 * Preferences live at `users/{uid}.preferences` (merged via setDoc +
 * { merge: true } inside AuthContext's updateUserPreferences). This
 * spec exercises the two enum-valued preferences that are easy to pin
 * without a complex-picker component: temperatureUnit (C ↔ F) and
 * timeFormat (12h ↔ 24h). TimezoneSelect is a bigger picker and not
 * particularly valuable to exercise when the underlying write path is
 * the same setDoc merge.
 *
 * Load-bearing contract: any flip in the UI Select → "save changes" →
 * writes to Firestore at the EXPECTED merge key. That's the guarantee
 * agents + other dashboard components rely on when they read
 * preferences to render temperatures / timestamps.
 *
 * `afterEach` restores the seeded preferences so consecutive runs on
 * a warm emulator don't drift.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

test.use(roleState('member'));

const MEMBER = TEST_USERS.member;

test.afterEach(async () => {
  const db = getAdminDb();
  await db.collection('users').doc(MEMBER.uid).set(
    {
      preferences: {
        temperatureUnit: 'C',
        timezone: 'UTC',
        timeFormat: '12h',
      },
    },
    { merge: true },
  );
});

test('member can flip temperatureUnit C→F and timeFormat 12h→24h; Firestore persists', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^preferences$/i }).first().click();

  // Temperature unit — shadcn Select with trigger id="temperatureUnit".
  await page.locator('#temperatureUnit').click();
  await page.getByRole('option', { name: 'Fahrenheit (°F)' }).click();

  // Time format — trigger id="timeFormat".
  await page.locator('#timeFormat').click();
  await page.getByRole('option', { name: '24-hour' }).click();

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // AuthContext's updateUserPreferences toasts on the non-silent path.
  await expect(page.getByText('Preferences Updated', { exact: true })).toBeVisible();

  // Admin SDK read-through — the real contract assertion.
  const db = getAdminDb();
  const snap = await db.collection('users').doc(MEMBER.uid).get();
  const prefs = snap.data()?.preferences;
  expect(prefs).toBeDefined();
  expect(prefs.temperatureUnit).toBe('F');
  expect(prefs.timeFormat).toBe('24h');
});

test('save without any change is a no-op (toast does not fire)', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^preferences$/i }).first().click();

  // Open the dialog on preferences but change nothing, then save.
  // handleSave checks `prefsChanged` before calling updateUserPreferences;
  // with no diff, no write happens and no toast fires. The dialog still
  // closes (no error path).
  await page.getByRole('button', { name: /^save changes$/i }).click();

  // Assert the dialog has closed (the preferences heading is gone from DOM).
  await expect(page.getByRole('heading', { name: 'preferences', exact: true })).toHaveCount(0);
  // Assert NO "Preferences Updated" toast appeared within a reasonable window.
  await expect(page.getByText('Preferences Updated', { exact: true })).toHaveCount(0);
});
