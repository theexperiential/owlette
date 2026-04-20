/**
 * Sites — access defaults (C2.4)
 *
 * The site-switcher scope is driven by useSites (web/hooks/useFirestore.ts).
 * Superadmins query the whole `sites` collection (platform god-mode);
 * everyone else fetches only the sites listed in their `users/{uid}.sites`
 * array.
 *
 * This spec pins that contract end-to-end:
 *   - member (sites: ['site-A']) → switcher lists site-A, NOT site-B
 *   - admin  (sites: ['site-A']) → switcher lists site-A, NOT site-B
 *   - superadmin (sites: []) → switcher lists BOTH site-A and site-B
 *
 * The owner-defaults contract (new sites have owner = creator.uid) is
 * already covered by C2.1's Admin SDK read-through, so we don't duplicate
 * it here.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const SITE_A_NAME = 'Site A (Assigned)';
const SITE_B_NAME = 'Site B (Unassigned)';

async function openSiteSwitcher(page: import('@playwright/test').Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  // The dropdown content has no accessible dialog/listbox wrapper name —
  // assert the first menuitem is visible as evidence it rendered.
  await expect(page.getByRole('menuitem').first()).toBeVisible();
}

test.describe('site-switcher scope — member', () => {
  test.use(roleState('member'));

  test('member assigned to site-A sees site-A but not site-B', async ({ page }) => {
    await openSiteSwitcher(page);

    await expect(page.getByRole('menuitem', { name: SITE_A_NAME })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: SITE_B_NAME })).toHaveCount(0);
  });
});

test.describe('site-switcher scope — admin', () => {
  test.use(roleState('admin'));

  test('admin assigned to site-A sees site-A but not site-B', async ({ page }) => {
    await openSiteSwitcher(page);

    await expect(page.getByRole('menuitem', { name: SITE_A_NAME })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: SITE_B_NAME })).toHaveCount(0);
  });
});

test.describe('site-switcher scope — superadmin', () => {
  test.use(roleState('superadmin'));

  test('superadmin sees both site-A and site-B (platform god-mode)', async ({ page }) => {
    await openSiteSwitcher(page);

    await expect(page.getByRole('menuitem', { name: SITE_A_NAME })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: SITE_B_NAME })).toBeVisible();
  });
});
