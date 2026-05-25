/**
 * Access-control — /admin/users page
 *
 * Only reachable as superadmin (gated by RequireSuperadmin). Covers:
 *   - stats row (4 cards in ascending-privilege order)
 *   - role badges per user (red Crown / green Shield / muted Users)
 *   - sites column variants (pills for admins, "all sites" for superadmin,
 *     count for members)
 *   - "You" badge on own row
 *   - role-change dialog (Select, description live-updates, save disabled
 *     when unchanged)
 *   - self-demote guard (superadmin can't demote themselves)
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('superadmin'));

test.describe('/admin/users — stats row', () => {
  test('shows 4 cards in ascending-privilege order', async ({ page }) => {
    await page.goto('/admin/users');

    const labels = ['total users', 'members', 'site admins', 'superadmins'];
    for (const label of labels) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // Confirm their visual order in the DOM matches ascending-privilege.
    const texts = await page
      .locator('p.text-sm.text-muted-foreground')
      .filter({ hasText: /total users|members|site admins|superadmins/ })
      .allTextContents();
    expect(texts).toEqual(labels);
  });

  test('counts reflect seeded fleet (1 super, 1 admin, 1 member)', async ({ page }) => {
    await page.goto('/admin/users');

    // Each stat card is a `.bg-card.rounded-lg` wrapping the count (p.text-2xl)
    // and label (p.text-sm). Find the card by its label, then read the count.
    const card = (label: string) =>
      page.locator('div.bg-card.rounded-lg').filter({ hasText: label });

    await expect(card('total users').locator('p.text-2xl')).toHaveText('3');
    await expect(card('members').locator('p.text-2xl')).toHaveText('1');
    await expect(card('site admins').locator('p.text-2xl')).toHaveText('1');
    await expect(card('superadmins').locator('p.text-2xl')).toHaveText('1');
  });
});

test.describe('/admin/users — role badges', () => {
  test('superadmin row shows Crown badge + "all sites" + You pill', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /super@e2e\.test/ });
    await expect(row.getByText('superadmin', { exact: true })).toBeVisible();
    await expect(row.getByText('all sites')).toBeVisible();
    await expect(row.getByText('you', { exact: true })).toBeVisible();
  });

  test('admin row shows admin badge + assigned site pill', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /admin@e2e\.test/ });
    await expect(row.getByText('admin', { exact: true })).toBeVisible();
    // The green site-id pill — seeded admin has sites: ['site-A']
    await expect(row.getByText('site-A')).toBeVisible();
  });

  test('member row shows member badge + site count (not pill list)', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /member@e2e\.test/ });
    await expect(row.getByText('member', { exact: true })).toBeVisible();
    // Member's sites column renders as two sibling spans ("1" + "site") with
    // a margin between them, not a single run of text. Target the label span
    // ("sites" or "site") and the preceding count span separately.
    const sitesCell = row.locator('td').nth(2);
    await expect(sitesCell).toContainText('1');
    await expect(sitesCell).toContainText(/site/);
    // No green site-id pill for members (admins get those).
    await expect(row.getByText('site-A', { exact: true })).toHaveCount(0);
  });
});

test.describe('/admin/users — role-change dialog', () => {
  test('save button disabled until role changes', async ({ page }) => {
    await page.goto('/admin/users');

    // Open member's action menu → click "change role..."
    const memberRow = page.getByRole('row', { name: /member@e2e\.test/ });
    await memberRow.getByRole('button').last().click(); // ⋮ menu
    await page.getByRole('menuitem', { name: /change role/i }).click();

    // Dialog open. Select shows current role (member) by default.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/current role:\s*member/i)).toBeVisible();

    // Save button disabled because newRole === currentRole.
    const saveBtn = dialog.getByRole('button', { name: /save role/i });
    await expect(saveBtn).toBeDisabled();
  });

  test('description updates live when new role picked; save enables', async ({ page }) => {
    await page.goto('/admin/users');

    const memberRow = page.getByRole('row', { name: /member@e2e\.test/ });
    await memberRow.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: /change role/i }).click();

    const dialog = page.getByRole('dialog');
    // Open the Select and pick 'admin'.
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: /admin/i }).first().click();

    // Description block now reflects admin's capabilities.
    await expect(dialog.getByText(/site-scoped elevated tier/i)).toBeVisible();

    // Save button enables.
    const saveBtn = dialog.getByRole('button', { name: /save role/i });
    await expect(saveBtn).toBeEnabled();
  });
});

test.describe('/admin/users — self-demote guard', () => {
  test('opening role change on own (superadmin) row is blocked', async ({ page }) => {
    await page.goto('/admin/users');

    const selfRow = page.getByRole('row', { name: /super@e2e\.test/ });
    await selfRow.getByRole('button').last().click();

    // The change-role item is disabled for self-superadmin.
    const changeRoleItem = page.getByRole('menuitem', { name: /change role/i });
    await expect(changeRoleItem).toBeDisabled();
  });
});
