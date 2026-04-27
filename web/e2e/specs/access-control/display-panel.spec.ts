/**
 * Access-control — DisplayLayoutPanel (site-scoped admin gates)
 *
 * The DisplayLayoutPanel hides its three write actions (store / restore /
 * clear) from any viewer who fails `isSiteAdmin(siteId)` — that's the
 * member/admin/superadmin site-scoping contract in action. This spec
 * automates the "display panel" row of the permission-model-split manual
 * smoke checklist (dev/active/permission-model-split/manual-smoke-checklist.md).
 *
 * Seeds one machine (`e2e-display-machine`) on site-A with two live
 * monitors so the panel mounts with a real display profile. Then, for each
 * role, opens the dashboard, switches to list view (single-click "view
 * displays" button is stabler than the card view's two-step expand +
 * click), opens the panel, and asserts on the gated buttons.
 *
 * NOTE: The manual checklist also lists an "editor toggle" and an
 * "auto-restore toggle" for this panel. Neither control exists in the
 * current DisplayLayoutPanel or DisplayEditorDialog (verified via grep);
 * those are aspirational rows that haven't shipped yet. This spec covers
 * the three buttons that actually exist in the component today
 * (store / restore / clear). When the editor + auto-restore toggles land,
 * add `canSiteAdmin`-gated + ungated assertions here per the checklist.
 */

import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-display-machine';

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb()
    .collection('config')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set({ displays: { remoteApplyEnabled: true } }, { merge: true });
});

/**
 * Common setup — go to /dashboard, switch to list view (one-click display
 * open via aria-labelled button), click "view displays" on the seeded
 * machine's row, and wait for the panel to mount.
 */
async function openDisplayPanel(page: Page): Promise<void> {
  await page.goto('/dashboard');

  // Flip to list view — the one-click "view displays" button is more stable
  // than the card view's two-step expand-then-click dance on the display
  // collapsible section.
  await page.getByTestId('view-toggle-list').click();

  // Click the machine row's "view displays" button (Monitor icon). The
  // list view renders one such button per row; we seed exactly one
  // machine so there's no ambiguity.
  await page.getByTestId('open-display-panel').click();

  // Panel slides open via a useLayoutEffect height animation; wait until
  // the Card itself is in the DOM before asserting on its children.
  await expect(page.getByTestId('display-layout-panel')).toBeVisible();
}

test.describe('display panel — member on site-A', () => {
  test.use(roleState('member'));

  test('opens the panel but sees no store/restore/clear buttons', async ({ page }) => {
    await openDisplayPanel(page);

    // Panel renders for read-only viewing — the member gets the live
    // topology but none of the write controls.
    const panel = page.getByTestId('display-layout-panel');
    await expect(panel.getByTestId('display-store-button')).toHaveCount(0);
    await expect(panel.getByTestId('display-recall-button')).toHaveCount(0);
    // Clear is only visible on the assigned tab with a saved layout —
    // never visible to a member regardless.
    await expect(panel.getByTestId('display-clear-button')).toHaveCount(0);
  });
});

test.describe('display panel — admin on site-A', () => {
  test.use(roleState('admin'));

  test('sees store + restore buttons on the live tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    // Both gated buttons render. They're disabled in our seeded state
    // (no assigned layout → restore disabled) but visibility is the contract
    // we're exercising, not enable-state.
    await expect(panel.getByTestId('display-store-button')).toBeVisible();
    await expect(panel.getByTestId('display-recall-button')).toBeVisible();
  });

  test('sees the "store current" CTA on the empty assigned tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    // Switch to the assigned tab; our seed has no assigned layout, so the
    // empty-state panel with the gated "store current" CTA renders.
    await panel.getByRole('button', { name: 'stored', exact: true }).click();
    await expect(panel.getByTestId('display-store-current-button')).toBeVisible();
  });
});

test.describe('display panel — superadmin', () => {
  test.use(roleState('superadmin'));

  test('sees store + restore buttons on the live tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    await expect(panel.getByTestId('display-store-button')).toBeVisible();
    await expect(panel.getByTestId('display-recall-button')).toBeVisible();
  });

  test('sees the "store current" CTA on the empty assigned tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    await panel.getByRole('button', { name: 'stored', exact: true }).click();
    await expect(panel.getByTestId('display-store-current-button')).toBeVisible();
  });
});
