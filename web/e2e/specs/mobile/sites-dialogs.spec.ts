/**
 * Mobile — sites dialogs (nav drawer → manage sites → create site)
 *
 * Viewport / isMobile / hasTouch come from the `mobile-chromium` project in
 * playwright.config.ts, which owns every spec under specs/mobile/**.
 *
 * Below `md` the site switcher in PageHeader is not rendered at all — the
 * breadcrumb collapses into a left nav drawer (PageHeader.tsx:170-179,
 * 390-500). `sites/create-site.spec.ts` and `sites/edit-site.spec.ts` drive
 * the desktop `site-switcher-trigger`, which does not exist at 390px, so
 * neither proves these dialogs are reachable on a phone. This spec walks the
 * drawer route end to end and asserts the resulting Firestore write.
 *
 * REGRESSION GUARD — inline site edit/delete used to be unreachable at 390px.
 * `ManageSitesDialog`'s header row was a no-wrap flex holding a `w-64
 * shrink-0` filter input; its min-content exceeded the dialog's
 * `max-w-[calc(100%-2rem)]` (~358px here), which inflated the DialogContent
 * grid's single auto column. Every site row inherits that column width, so
 * the fixed `64px` actions column carrying the per-row edit/delete buttons
 * landed outside the viewport with no horizontal scroller to bring it back,
 * and the header's close ✕ went off-screen for the same reason. The header
 * now wraps (`flex-wrap` on the row, `min-w-0 w-full max-w-64` on the filter),
 * so the search cluster takes its own line here while staying 256px wide on
 * desktop. "inline site edit and delete are reachable" below locks that in.
 *
 * `assertNoHorizontalOverflow` does NOT catch this class of bug: the dialog is
 * position-fixed, so its overflow never reaches the document scroll width —
 * hence the explicit `expectFullyWithinViewport` geometry checks. And never
 * substitute a synthetic/forced click at an off-screen button: that would be a
 * green test for something a phone user cannot do.
 *
 * Isolation: both the seeded collision fixture and every site created here are
 * deleted in `afterAll`, so the superadmin's site list is identical before and
 * after this file runs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { seedSite } from '../../helpers/seed';

/**
 * The baseline's `site-A` / `site-B` carry an uppercase letter and the
 * create dialog's id input downcases whatever is typed, so neither can be
 * used to trigger the "already taken" branch. Seed an all-lowercase id for
 * that case instead (same reasoning as `sites/create-site.spec.ts`).
 */
const TAKEN_SITE_ID = 'site-mobile-taken';
/**
 * Name of that same seeded site. It doubles as the row the reachability test
 * drives: it is owned by this file (deleted in `afterAll`) and the test only
 * opens the inline editor and cancels, so the baseline is never mutated.
 */
const TAKEN_SITE_NAME = 'Mobile Taken Site';

/** Site ids created by this file, deleted in afterAll. */
const createdSiteIds: string[] = [];

test.use(roleState('superadmin'));

/**
 * Open the mobile nav drawer and enter "manage sites". The drawer is plain
 * markup gated on `md:hidden` (not a portalled sheet), so it only exists at
 * this viewport.
 */
async function openManageSitesViaDrawer(page: Page): Promise<Locator> {
  await page.goto('/dashboard');

  await page.getByRole('button', { name: 'menu', exact: true }).click();
  const drawer = page.getByRole('navigation', { name: /site and page navigation/i });
  await expect(drawer).toBeVisible();

  await drawer.getByRole('button', { name: /manage sites/i }).click();
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  await seedSite({
    id: TAKEN_SITE_ID,
    name: TAKEN_SITE_NAME,
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(TAKEN_SITE_ID).delete(),
    ...createdSiteIds.map((id) => db.collection('sites').doc(id).delete()),
  ]);
});

test('the nav drawer lists sites and reaches manage-sites', async ({ page }) => {
  await page.goto('/dashboard');
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'menu', exact: true }).click();
  const drawer = page.getByRole('navigation', { name: /site and page navigation/i });
  await expect(drawer).toBeVisible();

  // The drawer is the mobile stand-in for the desktop breadcrumb: site list
  // first, then the page nav, then manage-sites.
  await expect(drawer.getByRole('button', { name: 'Site A (Assigned)' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /^roost/ })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await drawer.getByRole('button', { name: /manage sites/i }).click();
  await expect(page.getByRole('dialog', { name: /manage sites/i })).toBeVisible();
  // The drawer closes behind the dialog rather than stacking.
  await expect(drawer).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test('the create-site dialog writes the site from the drawer route', async ({ page }) => {
  const stamp = Date.now();
  const newSiteId = `e2e-mobile-site-${stamp}`;
  const newSiteName = `E2E Mobile Site ${stamp}`;
  createdSiteIds.push(newSiteId);

  const manageDialog = await openManageSitesViaDrawer(page);

  // "new site" closes manage-sites and opens the create dialog.
  await manageDialog.getByRole('button', { name: 'new site', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel('site name').fill(newSiteName);
  // The auto-generated slug is derived from the name; replace it with a
  // deterministic id so re-runs never collide.
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(newSiteId);
  await assertNoHorizontalOverflow(page);

  // Availability is debounced 500ms — the submit button enabling is the
  // signal that the check resolved to "available".
  const submit = createDialog.getByRole('button', { name: /^create site$/i });
  await expect(submit).toBeEnabled({ timeout: 5_000 });
  await submit.click();

  await expect(page.getByText(/created successfully/i)).toBeVisible();
  await expect(createDialog).toBeHidden();

  // Admin SDK read-through — the mobile path wrote the same doc shape the
  // desktop path does.
  const snap = await getAdminDb().collection('sites').doc(newSiteId).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(newSiteName);
  expect(snap.data()!.owner).toBe('super-uid');

  await assertNoHorizontalOverflow(page);
});

test('inline site edit and delete are reachable at 390px', async ({ page }) => {
  const dialog = await openManageSitesViaDrawer(page);

  // The filter input only renders above one site, and it is the control whose
  // width used to inflate the dialog — assert it is on screen before relying on
  // the rows behind it.
  await expect(dialog.getByLabel('filter sites')).toBeVisible();

  const editButton = dialog.getByRole('button', { name: `edit ${TAKEN_SITE_NAME}` });
  // Geometry before interaction: a tap that only "works" because Playwright
  // scrolled a horizontally overflowing container is not proof a thumb can
  // reach the control.
  await expectFullyWithinViewport(page, editButton, 'the row edit button');
  await editButton.tap();

  // The row swaps in place into the inline editor, pre-filled with the site's
  // current name.
  const nameInput = dialog.getByLabel('site name');
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue(TAKEN_SITE_NAME);
  await assertNoHorizontalOverflow(page);

  // Cancel returns the row to view mode without writing.
  await dialog.getByRole('button', { name: 'cancel', exact: true }).tap();
  await expect(nameInput).toBeHidden();
  await expect(editButton).toBeVisible();

  // Delete is the second control in the same fixed 64px actions column — the
  // half of it that never got its own tap here, but has to be on screen.
  await expectFullyWithinViewport(
    page,
    dialog.getByRole('button', { name: `delete ${TAKEN_SITE_NAME}` }),
    'the row delete button',
  );

  // The header ✕ rode the same overflow off-screen; it has to be tappable too.
  const closeButton = dialog.getByRole('button', { name: 'close', exact: true });
  await expectFullyWithinViewport(page, closeButton, 'the dialog close button');
  await closeButton.tap();
  await expect(dialog).toBeHidden();

  // Nothing was written — the seeded site still carries its original name.
  const snap = await getAdminDb().collection('sites').doc(TAKEN_SITE_ID).get();
  expect(snap.data()!.name).toBe(TAKEN_SITE_NAME);

  await assertNoHorizontalOverflow(page);
});

test('the create-site dialog blocks a taken site id at 390px', async ({ page }) => {
  const manageDialog = await openManageSitesViaDrawer(page);
  await manageDialog.getByRole('button', { name: 'new site', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel('site name').fill('Mobile Collision Site');
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(TAKEN_SITE_ID);

  // Debounced availability check resolves → "taken" → inline error + the
  // submit button stays disabled, all inside the viewport.
  await expect(createDialog.getByText(/already taken/i)).toBeVisible({ timeout: 5_000 });
  await expect(createDialog.getByRole('button', { name: /^create site$/i })).toBeDisabled();
  await assertNoHorizontalOverflow(page);
});
