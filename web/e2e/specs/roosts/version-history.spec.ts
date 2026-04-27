/**
 * Roosts — version history rendering (task 2.1)
 *
 * Asserts a roost with N versions renders newest-first, with #N numbers,
 * relative timestamps, descriptions (or the "(no description)" placeholder),
 * and the current-version dot only on the head row.
 *
 * Data plane: none — no push, no chunks, no /api/chunks calls.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-version-history-machine';
const ROOST_ID = 'rst_test_history_001';
const VERSION_COUNT = 5;
const DESCRIPTIONS: Array<string | null> = [
  null,
  'v2 work',
  'v3 work',
  'v4 work',
  'Bumped Q2 ads',
];
// Matches relativeTime() output in VersionRow.tsx (e.g. "just now", "12s ago",
// "3m ago", "2h ago", "5d ago", "1mo ago", "1y ago").
const TIMESTAMP_REGEX = /^(just now|\d+(s|m|h|d|mo|y) ago)$/;

async function cleanup() {
  const db = getAdminDb();
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
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: VERSION_COUNT,
    descriptions: DESCRIPTIONS,
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('expanded roost renders version rows newest-first with current marker on head', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  const versionRows = page.getByTestId('roost-version-row');
  await expect(versionRows).toHaveCount(VERSION_COUNT);
  const versionNumbers = versionRows.locator('span.font-mono', { hasText: /^#\d+$/ });
  await expect(versionNumbers).toHaveCount(VERSION_COUNT);

  // Newest-first ordering: #5 on top, #1 on bottom.
  const expectedOrder = ['#5', '#4', '#3', '#2', '#1'];
  for (let i = 0; i < expectedOrder.length; i++) {
    await expect(versionNumbers.nth(i)).toHaveText(expectedOrder[i]);
  }

  // Current-version dot — emerald-500 span with aria-label="current version",
  // rendered only when isCurrent is true. Exactly one across the panel.
  const currentMarkers = versionRows.getByLabel('current version');
  await expect(currentMarkers).toHaveCount(1);

  // Marker sits inside #5's row container.
  const headRow = page.locator('[data-testid="roost-version-row"][data-version-number="5"]');
  await expect(headRow).toContainText('#5');
  await expect(headRow).toContainText('Bumped Q2 ads');

  // v1 had description=null → "(no description)" placeholder renders.
  const v1Row = page.locator('[data-testid="roost-version-row"][data-version-number="1"]');
  await expect(v1Row).toContainText('(no description)');

  // Each row exposes a tabular-nums timestamp span; assert format on each.
  for (let i = 0; i < VERSION_COUNT; i++) {
    const timestamp = versionRows.nth(i)
      .locator('span.tabular-nums')
      .first();
    await expect(timestamp).toHaveText(TIMESTAMP_REGEX);
  }

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
