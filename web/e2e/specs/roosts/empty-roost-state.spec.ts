/**
 * Roosts — empty-state rendering (task 1.3)
 *
 * What this exercises:
 *   A roost that exists but has zero versions must render gracefully both
 *   in the collapsed list row and the expanded VersionHistory panel — no
 *   `vNaN`, no broken layout, no JS errors.
 *
 * Data plane: none — no push, no chunks, no http to /api/chunks.
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
  return (
    message.includes('Error fetching users: FirebaseError') ||
    message === '[Error] An error occurred'
  );
}

async function cleanup() {
  const db = getAdminDb();
  // Defensive: seedRoost writes no versions, but a prior failed run could
  // have left sub-collection docs behind. Wipe them before the doc itself.
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
  // Capture pageerror + console.error for the test lifetime. Asserted at
  // the end so a `vNaN` render bug surfaces even if visuals happen to pass.
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

  // ---- Assertion A — collapsed row ----
  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(ROOST_NAME);

  // The version-badge slot only renders when currentVersionNumber !== null
  // (per app/roosts/page.tsx). With no versions, the slot must be absent.
  await expect(row.locator('[aria-label^="current version"]')).toHaveCount(0);

  // Defensive: nothing in the document should ever read `vNaN`.
  await expect(page.locator('body')).not.toContainText('vNaN');

  // ---- Assertion B — expanded panel ----
  await row.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  // Empty-state copy is literal "no versions yet" (VersionHistory.tsx:124).
  await expect(page.getByText('no versions yet', { exact: true })).toBeVisible();

  // "+ new version" CTA inside the panel. Exact-match avoids the page-level
  // "new roost" button.
  await expect(page.getByRole('button', { name: 'new version', exact: true })).toBeVisible();

  // No error boundary copy.
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
  expect(consoleErrors, `console errors: ${consoleErrors.map((m) => m.text()).join(' | ')}`).toHaveLength(0);
});
