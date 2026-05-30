/**
 * Access-control — machine card / row (site-scoped admin gates)
 *
 * The dashboard's per-machine affordances hide a family of write actions
 * from any viewer who fails `isSiteAdmin(siteId)`. That's the
 * member/admin/superadmin site-scoping contract in action. This spec
 * automates the "dashboard — site access + machine panel" rows of the
 * permission-model-split manual smoke checklist
 * (dev/active/permission-model-split/manual-smoke-checklist.md), namely:
 *
 *   - restart/shutdown button visible on a machine card
 *   - cancel-countdown pill clickable during active restart
 *   - delete machine menu item visible
 *   - amber "restart pending" restart/cancel buttons visible
 *
 * The actions live in three places:
 *   1. MachineContextMenu — renders the restart / shutdown / cancel /
 *      revoke-token / remove-machine items, now gated on `isSiteAdmin`
 *      (added as part of B3.2 — the menu previously rendered them to
 *      every viewer).
 *   2. MachineStatusPill — the countdown variant is only clickable when
 *      `isSiteAdmin && onCancel && remaining > 5`. Non-admins see the
 *      text-only "restarting…" pill.
 *   3. MachineCardView's amber "restart pending" banner — already gated on
 *      `isSiteAdmin` (site-admins see approve/dismiss buttons, members
 *      see the banner without the action buttons).
 *
 * We seed three machines on site-A to exercise the three states in parallel:
 *   - e2e-machine-baseline — online, no restart in flight
 *   - e2e-machine-rebooting — online, in-flight restart with a 120s-future
 *     scheduledAt (well above the 5s cancel-lockout threshold)
 *   - e2e-machine-pending — online, rebootPending.active = true (amber
 *     banner shown, card-view only)
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-A';
const BASELINE_MACHINE_ID = 'e2e-machine-baseline';
const REBOOTING_MACHINE_ID = 'e2e-machine-rebooting';
const PENDING_MACHINE_ID = 'e2e-machine-pending';

test.beforeAll(async () => {
  // Three states, three machines — seeds coexist so a single dashboard
  // render exposes all of them at once.
  await seedMachine(SITE_ID, BASELINE_MACHINE_ID);
  await seedMachine(SITE_ID, REBOOTING_MACHINE_ID, { rebootingInSec: 120 });
  await seedMachine(SITE_ID, PENDING_MACHINE_ID, { rebootPending: true });
});

/**
 * Scope to the card for a given machine on the dashboard's default (card)
 * view. The card title contains the raw machineId, so filtering by hasText
 * is unambiguous as long as IDs don't share substrings — ours don't.
 */
async function cardFor(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: machineId });
  await expect(card).toBeVisible();
  return card;
}

/**
 * Scope to the row for a given machine after flipping to list view. The
 * row's hostname cell contains the raw machineId; filter by hasText.
 */
async function rowFor(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: machineId });
  await expect(row).toBeVisible();
  return row;
}

/**
 * Open the machine context menu (the MoreVertical ⋮ trigger) within a
 * previously-scoped card/row locator. Returns the open menu's popover —
 * the shadcn DropdownMenuContent portals out of the card, so we reach
 * for it via its role, not a descendant locator.
 */
async function openContextMenu(page: Page, scope: Locator): Promise<Locator> {
  await scope.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('machine card — member on site-A', () => {
  test.use(roleState('member'));

  test('context menu hides reboot + shutdown items on a healthy machine', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
  });

  test('context menu hides the remove-machine item', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
    // Revoke-token is also an admin action — hidden by the same gate.
    await expect(menu.getByTestId('machine-context-menu-revoke-token')).toHaveCount(0);
  });

  test('cancel-countdown pill during active reboot is read-only (no click handler)', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);

    // Admin variant is a <button data-testid="machine-status-cancel-pill">;
    // the member variant is a text-only <Badge> with no click handler and no
    // testid. Asserting count 0 is the contract: the button isn't rendered.
    await expect(card.getByTestId('machine-status-cancel-pill')).toHaveCount(0);

    // The pill itself is still rendered — it just shows the textual
    // "restarting…" state without interactivity. Spot-check that the amber
    // "restarting" copy is in the card so we're not accidentally asserting
    // on a missing pill.
    await expect(card).toContainText(/restarting/i);
  });

  test('context menu hides cancel-restart item during active restart', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-cancel-reboot')).toHaveCount(0);
  });

  test('amber restart-pending banner hides the approve/dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    // Banner itself is visible (members can see the reason); the gated
    // controls are approve + dismiss.
    await expect(card).toContainText(/restart pending/i);
    await expect(card.getByTestId('reboot-pending-approve')).toHaveCount(0);
    await expect(card.getByTestId('reboot-pending-dismiss')).toHaveCount(0);
  });

  test('list view: context menu hides reboot/shutdown/remove items', async ({ page }) => {
    const row = await rowFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, row);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
  });
});

test.describe('machine card — admin on site-A', () => {
  test.use(roleState('admin'));

  test('context menu shows reboot + shutdown items on a healthy machine', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
  });

  test('context menu shows the remove-machine item', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-revoke-token')).toBeVisible();
  });

  test('cancel-countdown pill during active reboot is clickable', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);

    // Clickable variant is a <button> element carrying the testid; the
    // badge-only variant renders without it. Visibility + tagName check
    // together pin the role contract.
    const pill = card.getByTestId('machine-status-cancel-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('type', 'button');
  });

  test('context menu shows cancel-reboot item during active reboot', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-cancel-reboot')).toBeVisible();
  });

  test('amber restart-pending banner shows approve + dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    await expect(card).toContainText(/restart pending/i);
    await expect(card.getByTestId('reboot-pending-approve')).toBeVisible();
    await expect(card.getByTestId('reboot-pending-dismiss')).toBeVisible();
  });
});

test.describe('machine card — superadmin', () => {
  test.use(roleState('superadmin'));

  test('context menu shows reboot + shutdown + remove items', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();
  });

  test('cancel-countdown pill during active reboot is clickable', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const pill = card.getByTestId('machine-status-cancel-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('type', 'button');
  });

  test('amber reboot-pending banner shows approve + dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    await expect(card.getByTestId('reboot-pending-approve')).toBeVisible();
    await expect(card.getByTestId('reboot-pending-dismiss')).toBeVisible();
  });
});
