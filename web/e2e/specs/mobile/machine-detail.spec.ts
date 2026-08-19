/**
 * Mobile — machine detail (expanded card)
 *
 * Viewport / isMobile / hasTouch come from the `mobile-chromium` project in
 * playwright.config.ts, which owns every spec under specs/mobile/**.
 *
 * `mobile/responsive-acceptance.spec.ts` proves the dashboard *renders* inside
 * 390px. This spec proves the card is still OPERABLE there: the collapsible
 * sections open, the context menu is reachable at a touch-sized hit area, and
 * both detail panels (metrics + display) mount from card controls — each step
 * followed by an overflow assertion, so a control that "works" by pushing the
 * document sideways still fails.
 *
 * Shared-fixture note: the three expand/collapse toggles are USER PREFERENCES
 * (`updateUserPreferences` in dashboard/page.tsx), not local component state —
 * toggling one writes `users/admin-uid.preferences` and every other spec that
 * renders a machine card inherits it. `resetExpandPrefs` therefore runs in
 * both `beforeEach` (order-independence inside this file) and `afterAll` (no
 * leak out of it); see commit cb94099 for that failure mode.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-detail-machine';
const PROCESS_ID = 'e2e-mobile-detail-proc';
const PROCESS_NAME = 'TouchDesigner.exe';
const CPU_PERCENT = 42;
const MEMORY_PERCENT = 61;

/**
 * Minimum touch target for the controls tagged `pointer-coarse:h-10 w-10`
 * (task 4.4). Playwright's `hasTouch` makes `pointer: coarse` match, so the
 * variant is live in this project and dead in `chromium`.
 */
const MIN_TOUCH_TARGET_PX = 40;

/**
 * Extend the seeded machine with the v2 metric shape the card's stats section
 * renders from. `joinMachineDevices` (hooks/useFirestore.ts) derives a
 * metric-only hardware profile when no `hardware/profile` doc exists, so
 * `metrics.cpus` + `metrics.memory` alone are enough to resolve a cpu device.
 * One process is added under `metrics.processes` — the same location
 * `dispatch/kill-process.spec.ts` seeds.
 */
async function seedDetailMachine(): Promise<void> {
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: Timestamp.now(),
          cpus: { CPU0: { percent: CPU_PERCENT, temperature: 54 } },
          memory: { percent: MEMORY_PERCENT, usedGb: 19.5 },
          primary: { cpu: 'CPU0' },
          processes: {
            [PROCESS_ID]: {
              name: PROCESS_NAME,
              status: 'RUNNING',
              pid: 4242,
              cpu_percent: 3.5,
              memory_mb: 512,
            },
          },
        },
      },
      { merge: true },
    );
}

/** Open the dashboard and scope to this spec's machine card. */
async function cardFor(page: Page): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  return card;
}

test.describe('mobile machine detail — admin on site-A', () => {
  test.use(roleState('admin'));

  /**
   * Pin the three expand flags to the app's own defaults
   * (AuthContext.tsx:431-433 — all three `?? true`). Written before every
   * test so the collapse/expand test cannot leave a later test in this file
   * looking at a collapsed card, and again in `afterAll` so it cannot leak
   * out of the file.
   */
  async function resetExpandPrefs(): Promise<void> {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set(
        {
          preferences: {
            statsExpanded: true,
            processesExpanded: true,
            displaysExpanded: true,
          },
        },
        { merge: true },
      );
  }

  test.beforeAll(async () => {
    await seedDetailMachine();
  });

  test.beforeEach(async () => {
    await resetExpandPrefs();
  });

  test.afterAll(async () => {
    await resetExpandPrefs();
    // Drop the machine so the dashboard's card count is unchanged for
    // whatever runs next.
    await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(MACHINE_ID)
      .delete();
  });

  test('collapsing and re-expanding the card sections keeps the page inside the viewport', async ({ page }) => {
    const card = await cardFor(page);

    // All three sections start expanded: AuthContext.tsx:431-433 defaults
    // stats/processes/displays to `?? true`, so the card's opening state is
    // the fully-expanded one — the widest thing it ever renders.
    await expect(card.getByText(`${CPU_PERCENT}%`, { exact: true })).toBeVisible();
    await expect(card.getByText(`${MEMORY_PERCENT}%`, { exact: true })).toBeVisible();
    await expect(card.getByText(PROCESS_NAME, { exact: true })).toBeVisible();
    await expect(card.getByText('running', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 2', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // The dashboard's expand/collapse-all control is icon-only with no
    // accessible name, so it is addressed by its lucide glyph — the same
    // convention `settings/webhooks-manage.spec.ts` uses. `ChevronsDownUp`
    // is the "collapse all" state (dashboard/page.tsx:1030).
    await page.locator('button:has(svg.lucide-chevrons-down-up)').click();

    // Collapsed: each section falls back to its one-line summary trigger.
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeHidden();
    await expect(card.getByRole('button').filter({ hasText: /2 displays/i })).toBeVisible();
    await expect(card.getByRole('button').filter({ hasText: /1 process/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Re-expand just the displays section through its own trigger. Located by
    // TEXT rather than accessible name: the header's display shortcut is
    // icon-only with `aria-label="view displays"`, which a name-based match
    // would also hit.
    await card.getByRole('button').filter({ hasText: /2 displays/i }).click();
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 2', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Back to fully expanded via the same control (now in its "expand all"
    // state), so the card ends this test the way it started it.
    await page.locator('button:has(svg.lucide-chevrons-up-down)').click();
    await expect(card.getByText(PROCESS_NAME, { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('the context menu has a touch-sized trigger and opens its admin actions', async ({ page }) => {
    const card = await cardFor(page);

    // `pointer-coarse:h-10 pointer-coarse:w-10` on MachineContextMenu.tsx:197
    // only resolves when the primary pointer is coarse — i.e. exactly this
    // project. Assert the grown size rather than that the class is present.
    const trigger = card.getByTestId('machine-context-menu-trigger');
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();

    await assertNoHorizontalOverflow(page);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('tapping a metric row opens the metrics detail panel', async ({ page }) => {
    const card = await cardFor(page);

    // The whole row carries the click handler; the percentage is a child, so
    // the tap bubbles. No metrics_history is seeded, so the panel resolves to
    // its deterministic empty-range copy rather than a chart.
    await card.getByText(`${CPU_PERCENT}%`, { exact: true }).click();
    await expect(
      page.getByText(/no data available for this time range/i),
    ).toBeVisible({ timeout: 15_000 });

    await assertNoHorizontalOverflow(page);
  });

  test('tapping the display icon opens the display layout panel', async ({ page }) => {
    const card = await cardFor(page);

    await card.getByTestId('open-display-panel').click();
    const panel = page.getByTestId('display-layout-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('display-store-button')).toBeVisible();

    await assertNoHorizontalOverflow(page);
  });
});
