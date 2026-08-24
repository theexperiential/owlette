/**
 * Account — user preferences at `users/{uid}.preferences` (setDoc merge in
 * AuthContext's updateUserPreferences).
 *
 * Covers the two enum preferences that pin without a complex picker:
 * temperatureUnit and timeFormat. TimezoneSelect shares the same write path.
 *
 * Contract under test: a UI Select flip + "save changes" writes to the EXPECTED
 * merge key — what agents and other components rely on when reading
 * preferences. `afterEach` restores the seed so warm-emulator runs don't drift.
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

  // shadcn Select, trigger id="temperatureUnit".
  await page.locator('#temperatureUnit').click();
  await page.getByRole('option', { name: 'Fahrenheit (°F)' }).click();

  await page.locator('#timeFormat').click();
  await page.getByRole('option', { name: '24-hour' }).click();

  await page.getByRole('button', { name: /^save changes$/i }).click();

  // updateUserPreferences toasts on the non-silent path.
  await expect(page.getByText('Preferences Updated', { exact: true })).toBeVisible();

  // The real contract assertion: read back through the Admin SDK.
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

  // handleSave checks `prefsChanged` first, so a no-diff save writes nothing
  // and fires no toast — but still closes the dialog.
  await page.getByRole('button', { name: /^save changes$/i }).click();

  await expect(page.getByRole('heading', { name: 'preferences', exact: true })).toHaveCount(0);
  await expect(page.getByText('Preferences Updated', { exact: true })).toHaveCount(0);
});
