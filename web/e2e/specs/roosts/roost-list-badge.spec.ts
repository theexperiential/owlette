/**
 * Roosts — list-row badge + description preview + timestamp (task 1.2)
 *
 * what this exercises: the /roosts list row, when the roost has versions,
 * renders the v{N} current-version badge, description preview (truncated
 * to 40 chars with an ellipsis when longer), a timestamp, and the
 * row-actions three-dot trigger. data plane: none.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-roost-list-badge';
const ROOST_ID = 'rst_test_badge_001';

// keep in sync with DESCRIPTION_PREVIEW_CAP in `web/app/roosts/page.tsx` —
// long descriptions render as the first 40 chars + U+2026.
const DESCRIPTION_PREVIEW_CAP = 40;

async function cleanupRoost() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanupRoost();
  await seedMachine(SITE_ID, MACHINE_ID);
});

test.afterEach(async () => {
  await cleanupRoost();
});

test('row renders v3 badge, short description preview, timestamp, and three-dot trigger', async ({ page }) => {
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: [null, 'Initial publish', 'Bumped Q2 ads'],
  });

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  // No `listitem` role — wrapper is a plain div + the clickable region is a
  // button stamped with `data-roost-row={roostId}`. Scope assertions to the
  // wrapper so the badge/description/actions match only this row.
  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');
  await expect(row.getByText(ROOST_ID)).toBeVisible();

  // current-version badge — `<span aria-label="current version v3">v3</span>`.
  await expect(row.getByLabel('current version v3')).toHaveText('v3');

  // 14-char description ("Bumped Q2 ads") < 40 → rendered as-is, no ellipsis.
  await expect(row.getByText('Bumped Q2 ads', { exact: true })).toBeVisible();

  // timestamp — `formatSiteScopedTimestamp` produces an absolute string
  // ("April 24, 2026, 10:32:14 PM UTC") on this site-scoped surface, not a
  // "just now" relative form. Match month + 4-digit year + HH:MM tokens so
  // the assertion isn't pinned to wall-clock seconds.
  await expect(
    row.getByText(/(January|February|March|April|May|June|July|August|September|October|November|December) \d+, \d{4},?\s+\d{1,2}:\d{2}/i)
  ).toBeVisible();

  // three-dot row-actions trigger — accessible name from `aria-label="row actions"`.
  await expect(row.getByRole('button', { name: 'row actions' })).toBeVisible();
});

test('long description is truncated to 40 chars with an ellipsis', async ({ page }) => {
  // 100 chars — exceeds the 40-char cap, so preview is first 40 chars + U+2026.
  const longDescription = 'a'.repeat(100);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: [null, 'Initial publish', longDescription],
  });

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');

  const expectedPreview = `${longDescription.slice(0, DESCRIPTION_PREVIEW_CAP)}…`;
  await expect(row.getByText(expectedPreview, { exact: true })).toBeVisible();
  // Sanity — the full 100-char string is NOT rendered untruncated.
  await expect(row.getByText(longDescription, { exact: true })).toHaveCount(0);
});
