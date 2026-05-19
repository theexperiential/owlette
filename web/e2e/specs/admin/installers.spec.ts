/**
 * Admin — installer versions page (C3.1)
 *
 * Firestore shape (seeded here via Admin SDK — bypasses Storage entirely):
 *   - `installer_metadata/data/versions/{version}` — one doc per version
 *   - `installer_metadata/latest` — pointer doc cloned from the current
 *     latest version's metadata
 *
 * Covered:
 *   - list rendering: seeded versions appear in the table with size +
 *     uploaded-by; stats card shows the current latest; "Latest" badge
 *     lands on the latest row only
 *   - set-as-latest: clicking on the non-latest row opens the confirmation
 *     dialog, confirming writes the Firestore `latest` doc and flips the
 *     "Latest" badge
 *   - per-row guards on the latest version: neither the "set as latest"
 *     button nor the trash button renders for the row that is already
 *     latest (belt-and-braces against handler-level guards inside the
 *     page component)
 *   - upload entry point: the "upload new version" button opens the
 *     upload dialog with the expected title
 *
 * Not covered:
 *   - end-to-end upload via Storage emulator — requires a real .exe
 *     fixture; value/cost ratio is low when the Firestore metadata
 *     shape is already pinned by seed + list tests
 *   - delete happy path — the hook calls deleteObject() against Storage
 *     first, which would fail for seeded-only versions; deferred until
 *     we have a stubStorage helper (planned for D1)
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';

test.use(roleState('superadmin'));

interface SeededInstaller {
  version: string;
  file_size: number;
  uploadedDaysAgo: number;
  release_notes?: string;
}

const OLDER_VERSION: SeededInstaller = {
  version: '2.0.0',
  file_size: 90_000_000,
  uploadedDaysAgo: 14,
  release_notes: 'initial release',
};

const LATEST_VERSION: SeededInstaller = {
  version: '2.1.0',
  file_size: 100_000_000,
  uploadedDaysAgo: 1,
  release_notes: 'minor feature release',
};

function makeVersionData(spec: SeededInstaller) {
  const d = new Date();
  d.setDate(d.getDate() - spec.uploadedDaysAgo);
  return {
    version: spec.version,
    download_url: `https://storage.emulator/installers/${spec.version}/Owlette.exe`,
    file_size: spec.file_size,
    release_date: Timestamp.fromDate(d),
    uploaded_at: d.getTime(),
    checksum_sha256: 'deadbeef'.repeat(8),
    uploaded_by: 'super@e2e.test',
    deletedAt: null,
    ...(spec.release_notes ? { release_notes: spec.release_notes } : {}),
  };
}

async function seedInstallerMetadata() {
  const db = getAdminDb();
  const versionsCol = db.collection('installer_metadata').doc('data').collection('versions');
  const latestDoc = db.collection('installer_metadata').doc('latest');

  // Clear prior state so reruns + previous tests don't leak.
  const existing = await versionsCol.get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));

  await versionsCol.doc(OLDER_VERSION.version).set(makeVersionData(OLDER_VERSION));
  await versionsCol.doc(LATEST_VERSION.version).set(makeVersionData(LATEST_VERSION));
  await latestDoc.set(makeVersionData(LATEST_VERSION));
}

test.beforeEach(async () => {
  await seedInstallerMetadata();
});

test('lists seeded versions with sizes, uploader and the latest badge on the right row', async ({ page }) => {
  await page.goto('/admin/installers');

  // Heading pins the page. Bumped to 10s because RequireSuperadmin renders a
  // "verifying permissions..." gate while AuthContext hydrates against the
  // auth emulator; the default 5s expect timeout occasionally races that
  // hydration on cold-emulator runs. Subsequent heading checks in this spec
  // keep the same bump.
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // Stats card shows the latest version.
  await expect(page.getByText('current latest version')).toBeVisible();
  // The stats card contains the version number as the 2xl heading-like p.
  // Scope to the card region to avoid matching the same text in the table.
  const statsCard = page
    .locator('div.bg-card.border')
    .filter({ hasText: 'current latest version' });
  await expect(statsCard.getByText(LATEST_VERSION.version, { exact: true })).toBeVisible();

  // Both versions render in the table.
  const table = page.locator('table');
  const olderRow = table.locator('tr').filter({ hasText: OLDER_VERSION.version });
  const latestRow = table.locator('tr').filter({ hasText: LATEST_VERSION.version });

  await expect(olderRow).toBeVisible();
  await expect(latestRow).toBeVisible();

  // Uploaded-by column.
  await expect(latestRow).toContainText('super@e2e.test');

  // "Latest" badge only on the latest row.
  await expect(latestRow.getByText('Latest', { exact: true })).toBeVisible();
  await expect(olderRow.getByText('Latest', { exact: true })).toHaveCount(0);

  // File-size column is formatted by formatFileSize() — 100_000_000 ≈ "95.4 MB".
  // Assert only on presence of an MB-formatted string to avoid pinning the exact
  // rounded output.
  await expect(latestRow).toContainText(/MB/);
});

test('the latest row hides the set-as-latest and delete buttons', async ({ page }) => {
  await page.goto('/admin/installers');
  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const latestRow = page.locator('table tr').filter({ hasText: LATEST_VERSION.version });
  await expect(latestRow).toBeVisible();

  // No "set as latest" button on the already-latest row.
  await expect(latestRow.getByRole('button', { name: /set as latest/i })).toHaveCount(0);

  // The trash button is also omitted — the page renders a spacer div instead.
  // Scope the download/copy icon buttons (which DO render) and assert the
  // row has exactly those two icon buttons in its actions cell, no trash.
  // The trash icon's svg would sit inside a button with the delete handler;
  // the simplest negative is via class — red-400 is the trash-only color.
  await expect(latestRow.locator('button.text-red-400')).toHaveCount(0);

  // The older row DOES have the set-as-latest affordance + a trash button.
  const olderRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  await expect(olderRow.getByRole('button', { name: /set as latest/i })).toBeVisible();
  await expect(olderRow.locator('button.text-red-400')).toHaveCount(1);
});

test('set-as-latest confirms via dialog and updates Firestore latest doc', async ({ page }) => {
  await page.goto('/admin/installers');
  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const olderRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  await olderRow.getByRole('button', { name: /set as latest/i }).click();

  const confirmDialog = page.getByRole('dialog', { name: /^set as latest version$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(OLDER_VERSION.version);

  await confirmDialog.getByRole('button', { name: /^OK$/ }).click();

  // Success toast uses the "Latest Version Updated" title copy.
  await expect(page.getByText(/latest version updated/i)).toBeVisible();

  // Badge flips — the former latest no longer has it.
  const newLatestRow = page.locator('table tr').filter({ hasText: OLDER_VERSION.version });
  const oldLatestRow = page.locator('table tr').filter({ hasText: LATEST_VERSION.version });
  await expect(newLatestRow.getByText('Latest', { exact: true })).toBeVisible();
  await expect(oldLatestRow.getByText('Latest', { exact: true })).toHaveCount(0);

  // Admin SDK read-through — the real contract assertion.
  const db = getAdminDb();
  const latest = await db.collection('installer_metadata').doc('latest').get();
  expect(latest.exists).toBe(true);
  expect(latest.data()!.version).toBe(OLDER_VERSION.version);
});

test('clicking "upload new version" opens the upload dialog', async ({ page }) => {
  await page.goto('/admin/installers');
  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'installers', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /upload new version/i }).click();

  await expect(
    page.getByRole('dialog', { name: /^upload new installer version$/i }),
  ).toBeVisible();
});
