/**
 * Roosts — a roost with zero versions must render cleanly in both the
 * collapsed row and the expanded VersionHistory panel: no `vNaN`, no broken
 * layout, no JS errors. No data plane.
 */

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoost } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-empty-roost-machine';
const ROOST_ID = 'rst_test_empty_001';
const ROOST_NAME = 'empty-roost';

function isKnownPageChromeNoise(message: string): boolean {
  return message === '[Error] An error occurred';
}

async function cleanup() {
  const db = getAdminDb();
  // A prior failed run can leave sub-collection docs; wipe before the doc.
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoost(SITE_ID, ROOST_ID, { name: ROOST_NAME });
});

test.afterEach(async () => {
  await cleanup();
});

test('roost with zero versions renders cleanly in collapsed row + expanded panel', async ({ page }) => {
  // Asserted at the end so a `vNaN` render bug surfaces even if visuals pass.
  const pageErrors: Error[] = [];
  const consoleErrors: ConsoleMessage[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isKnownPageChromeNoise(msg.text())) {
      consoleErrors.push(msg);
    }
  });

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(ROOST_NAME);

  // roosts/page.tsx only renders the badge when currentVersionNumber !== null.
  await expect(row.locator('[aria-label^="current version"]')).toHaveCount(0);

  await expect(page.locator('body')).not.toContainText('vNaN');

  await row.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  // Literal copy from VersionHistory.tsx:124.
  await expect(page.getByText('no versions yet', { exact: true })).toBeVisible();

  // Exact-match so the page-level "new roost" button doesn't collide.
  await expect(page.getByRole('button', { name: 'new version', exact: true })).toBeVisible();

  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
  expect(consoleErrors, `console errors: ${consoleErrors.map((m) => m.text()).join(' | ')}`).toHaveLength(0);
});
