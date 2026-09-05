/**
 * The site-time confirmation banner on the dashboard — the one-time "whose clock
 * runs your schedules?" prompt (dev/active/site-time-schedules, wave 3a).
 *
 * `sites/{siteId}.schedulesFollowSiteTime` is three-state, and the ABSENCE of the
 * field is the state this banner exists for. Every shared fixture deliberately
 * leaves it absent — `seedSite` never writes it, and adding it would flip the
 * clock semantics under every recorded tutorial frame — so this spec creates the
 * state it needs by deleting the field around each test rather than by teaching
 * the fixture about it.
 *
 * Two roles, on purpose. The banner is gated on `isSiteAdmin(siteId)`, and a
 * suite that only ever runs as an admin cannot tell a working capability check
 * from a missing one. The member case here is the negative control.
 *
 * Cleanup is not optional: a scheduled process left on site-A would make this
 * banner appear on the dashboard for every later admin/superadmin spec, since
 * they all share the site.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  machineCard,
  pinDashboardContext,
  seedMachineWithProcesses,
  toasts,
} from '../../helpers/processConfig';

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-site-time-machine';
const PROCESS_ID = 'proc-site-time';
const PROCESS_NAME = 'site-time-show.exe';

const banner = (page: Page) => page.getByTestId('site-time-banner');

/**
 * Back to "never asked". `update` (not `set`) on purpose: it throws if site-A has
 * gone missing, which is a fixture failure worth seeing rather than papering over
 * by recreating a half-formed site document.
 */
async function clearSiteTimeFlag(): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .update({ schedulesFollowSiteTime: FieldValue.delete() });
}

async function readSiteTimeFlag(): Promise<unknown> {
  const snap = await getAdminDb().collection('sites').doc(SITE_ID).get();
  return snap.data()?.schedulesFollowSiteTime;
}

async function removeSeededMachine(): Promise<void> {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete(),
    db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete(),
  ]);
}

/** One scheduled process is the whole precondition — the banner counts them. */
async function seedScheduledProcess(): Promise<void> {
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, [
    {
      id: PROCESS_ID,
      name: PROCESS_NAME,
      launch_mode: 'scheduled',
      schedules: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
      ],
      status: 'RUNNING',
      pid: 1234,
    },
  ]);
}

test.beforeEach(async () => {
  await clearSiteTimeFlag();
  await seedScheduledProcess();
});

test.afterEach(async () => {
  await removeSeededMachine();
  await clearSiteTimeFlag();
});

test.describe('as a site admin', () => {
  test.use(roleState('admin'));

  test.beforeEach(async () => {
    await pinDashboardContext(TEST_USERS.admin.uid, SITE_ID);
  });

  test('the banner offers the choice, and declining is terminal', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(machineCard(page, MACHINE_ID)).toBeVisible({ timeout: 15_000 });

    const prompt = banner(page);
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('one scheduled process on this site runs');
    // seedMachine writes agent_version 2.9.0, which is below the minimum that
    // honours site time — so the advisory names the machine. Copy only: both
    // actions stay available.
    await expect(page.getByTestId('site-time-banner-version-advisory')).toContainText(
      MACHINE_ID,
    );
    await expect(page.getByTestId('site-time-banner-use-site-time')).toBeEnabled();

    const patch = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/sites/${SITE_ID}`) && res.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await page.getByTestId('site-time-banner-keep-machine-clocks').click();
    expect((await patch).status()).toBe(200);

    await expect(toasts(page).filter({ hasText: 'schedules stay on each machine' })).toBeVisible();

    // `false`, never a deleted field: "declined" and "never asked" are different
    // states, and only the flag's presence stops the re-prompt.
    await expect
      .poll(readSiteTimeFlag, { timeout: 10_000 })
      .toBe(false);

    // The live site snapshot retires the banner without a reload...
    await expect(prompt).toBeHidden();

    // ...and a reload does not bring it back.
    await page.reload();
    await expect(machineCard(page, MACHINE_ID)).toBeVisible({ timeout: 15_000 });
    await expect(banner(page)).toHaveCount(0);
  });

  test('a site with no scheduled process is never prompted', async ({ page }) => {
    await seedMachineWithProcesses(SITE_ID, MACHINE_ID, [
      { id: PROCESS_ID, name: PROCESS_NAME, launch_mode: 'always', status: 'RUNNING', pid: 1234 },
    ]);

    await page.goto('/dashboard');
    await expect(machineCard(page, MACHINE_ID)).toBeVisible({ timeout: 15_000 });

    await expect(banner(page)).toHaveCount(0);
    expect(await readSiteTimeFlag()).toBeUndefined();
  });
});

test.describe('as a member (negative control)', () => {
  test.use(roleState('member'));

  test.beforeEach(async () => {
    await pinDashboardContext(TEST_USERS.member.uid, SITE_ID);
  });

  test('sees the same site and the same scheduled process, but no banner', async ({ page }) => {
    await page.goto('/dashboard');
    // Proves the page resolved to site-A with the seeded machine — otherwise an
    // absent banner would prove nothing.
    await expect(machineCard(page, MACHINE_ID)).toBeVisible({ timeout: 15_000 });

    await expect(banner(page)).toHaveCount(0);
    // And the flag is still unanswered, so this is the gate and not a leftover.
    expect(await readSiteTimeFlag()).toBeUndefined();
  });
});
