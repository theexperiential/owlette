/**
 * Roosts — publish new version of an existing roost (task 3.4)
 *
 * What this exercises:
 *   The full v2 push pipeline against an existing roost — the load-bearing
 *   spec for project-distribution-v2:
 *     1. open the per-roost "+ new version" modal from the expanded
 *        VersionHistory panel
 *     2. assert locked-field UX (name/extractPath/targets all pre-filled
 *        + disabled; only file picker + description editable)
 *     3. drop a tiny in-memory file → browser hashes it
 *     4. /api/chunks/check + /api/chunks/upload-urls + R2 PUT all
 *        intercepted by `installPushMocks`
 *     5. POST /api/roosts/{id}/versions hits the real finalize handler
 *        (chunk presence verified against pre-seeded `siteChunks` rows)
 *     6. Firestore: new version doc lands; roost pointers flip to v4
 *     7. dialog closes, success toast fires, version list re-renders,
 *        list-row badge updates to v4
 *
 * Data plane: mocked via pushMocks (no real R2, no real chunk hashing
 * downstream — the browser DOES hash 'hello roost' so the digest matches
 * the seeded `siteChunks/{digest}` row that `verifyChunksPresent` reads
 * server-side under OWLETTE_E2E=1).
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import {
  seedMachine,
  seedRoostWithVersionHistory,
  seedChunks,
} from '../../helpers/seed';
import { installPushMocks, uninstallPushMocks } from '../../helpers/pushMocks';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-newversion-machine';
const ROOST_ID = 'rst_test_newversion_001';
const ROOST_NAME = 'lobby';
const EXTRACT_PATH = 'C:/ProgramData/Owlette/projects/lobby';

// SHA-256('hello roost') — pre-computed via node:crypto. The browser hashes
// this exact 11-byte payload via the chunking pipeline (one chunk, since
// 11 bytes ≪ CHUNK_SIZE_BYTES = 4 MiB), produces the same digest, and
// references it in (a) the /chunks/check + /chunks/upload-urls + R2 PUT
// path AND (b) the version envelope's files[0].chunks[0].hash.
// `seedChunks` writes `siteChunks/{HASH}` so the finalize handler's
// `verifyChunksPresent` lookup passes under OWLETTE_E2E=1 (see
// web/lib/r2Client.server.ts:hasChunk).
const FILE_BYTES = 'hello roost';
const FILE_HASH =
  '85e51c16208e35bacd07fb2dabcc79f78c68c53a2f3570ec04785638e7d28aa4';

async function cleanup() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
  await db.collection('siteChunks').doc(FILE_HASH).delete().catch(() => {
    /* idempotent — first run has nothing to delete */
  });
}

test.beforeEach(async ({ page }) => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    name: ROOST_NAME,
    targets: [MACHINE_ID],
    extractPath: EXTRACT_PATH,
  });
  // Pre-seed the chunk presence row so the real finalize handler's
  // `verifyChunksPresent` (→ hasChunk → siteChunks/{hash}) passes without
  // talking to R2. Without this, finalize 412s with "chunks missing".
  await seedChunks(SITE_ID, [FILE_HASH]);

  // The FolderDropzone prefers `showDirectoryPicker` / `showOpenFilePicker`
  // when defined (Chrome/Edge — and headless chromium qualifies), and those
  // pickers can't be driven by `setInputFiles`. Stripping them before any
  // page script runs forces the `<input type="file">` fallback, which IS
  // setInputFiles-friendly.
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker;
    delete (window as unknown as { showOpenFilePicker?: unknown })
      .showOpenFilePicker;
  });

  await installPushMocks(page, { missing: [FILE_HASH] });
});

test.afterEach(async ({ page }) => {
  await uninstallPushMocks(page);
  await cleanup();
});

test('+ new version round-trips through the full push pipeline', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  // Pre-condition — list row currently shows v3.
  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[aria-label^="current version"]')).toHaveText('v3');

  // Expand the panel.
  await row.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  // Click the "+ new version" button inside the VersionHistory panel.
  await page.getByRole('button', { name: /^new version$/i }).click();

  // Modal opens in new-version mode — title disambiguates by roost name.
  const dialog = page.getByRole('dialog', { name: /^publish new version of "lobby"$/i });
  await expect(dialog).toBeVisible();

  // ---- locked-field UX ----
  const nameInput = dialog.locator('#distribution-name');
  await expect(nameInput).toBeDisabled();
  await expect(nameInput).toHaveValue(ROOST_NAME);

  const extractInput = dialog.locator('#extract-path');
  await expect(extractInput).toBeDisabled();
  await expect(extractInput).toHaveValue(EXTRACT_PATH);

  await expect(dialog.getByText(/target machines.*locked/i)).toBeVisible();
  const targetCheckboxes = dialog.getByRole('checkbox');
  const checkboxCount = await targetCheckboxes.count();
  expect(checkboxCount).toBeGreaterThan(0);
  for (let i = 0; i < checkboxCount; i++) {
    await expect(targetCheckboxes.nth(i)).toBeDisabled();
  }
  // The seeded target machine is the one ticked.
  const seededCheckbox = dialog.getByRole('checkbox', { name: MACHINE_ID });
  await expect(seededCheckbox).toBeChecked();

  // ---- editable fields ----
  const description = dialog.locator('#distribution-description');
  await expect(description).toBeEnabled();
  await description.fill('bumped Q2 ads');

  // FolderDropzone's "browse files" fallback renders <input type="file"
  // multiple hidden> alongside the label. setInputFiles on the hidden
  // input fires `handleLooseFilesPick` which routes through `deliver` →
  // `onFilesReady`, populating `droppedFiles` in the dialog.
  const fileInput = dialog.locator('input[type="file"]:not([webkitdirectory])').first();
  await fileInput.setInputFiles({
    name: 'test.toe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(FILE_BYTES),
  });

  // Summary chip materialises once enumeration completes — confirms the
  // file landed in droppedFiles before we hit submit.
  await expect(dialog.getByText(/^1 file$/)).toBeVisible();

  // ---- submit + assert response ----
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/versions`) &&
      res.request().method() === 'POST',
    { timeout: 30_000 },
  );

  // In new-version mode the dialog ALWAYS provides targets (locked,
  // pre-filled), so the primary action is "upload and distribute to N
  // machine(s)" — not the bare "upload" upload-only button.
  await dialog.getByRole('button', { name: /^upload and distribute to \d+ machine/i }).click();

  const response = await responsePromise;
  expect(response.status()).toBe(201);

  // Response body: `{versionId, versionNumber, currentVersionId, previousVersionId}`.
  const responseBody = (await response.json()) as Record<string, unknown>;
  expect(responseBody.versionNumber).toBe(4);
  expect(typeof responseBody.versionId).toBe('string');
  expect(responseBody.previousVersionId).toBe(`vrs_${ROOST_ID}_v3`);
  const newVersionId = responseBody.versionId as string;

  // Request body: OCI version envelope wrapped alongside name/targets/etc.
  const reqBody = response.request().postDataJSON() as Record<string, unknown>;
  expect(reqBody).toMatchObject({
    siteId: SITE_ID,
    name: ROOST_NAME,
    targets: [MACHINE_ID],
    description: 'bumped Q2 ads',
  });
  const envelope = reqBody.version as Record<string, unknown>;
  expect(envelope).toMatchObject({
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
  });
  const files = envelope.files as Array<{
    path: string;
    size: number;
    chunks: Array<{ hash: string; size: number }>;
  }>;
  expect(Array.isArray(files)).toBe(true);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe('test.toe');
  expect(files[0].size).toBe(FILE_BYTES.length);
  expect(files[0].chunks).toHaveLength(1);
  expect(files[0].chunks[0].hash).toBe(FILE_HASH);
  expect(files[0].chunks[0].size).toBe(FILE_BYTES.length);

  // ---- Firestore: new version doc + roost pointer flips ----
  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('roosts').doc(ROOST_ID)
        .collection('versions').doc(newVersionId).get();
      return snap.exists ? snap.data() : null;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toMatchObject({
    versionNumber: 4,
    description: 'bumped Q2 ads',
    parentVersionId: `vrs_${ROOST_ID}_v3`,
  });

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('roosts').doc(ROOST_ID).get();
      const data = snap.data() ?? {};
      return {
        currentVersionId: data.currentVersionId,
        previousVersionId: data.previousVersionId,
        versionCounter: data.versionCounter,
      };
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toEqual({
    currentVersionId: newVersionId,
    previousVersionId: `vrs_${ROOST_ID}_v3`,
    versionCounter: 4,
  });

  // ---- UI: dialog closes, list-row badge bumps to v4, panel re-fetches ----
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Success toast — copy in ProjectDistributionDialog's terminal-state effect
  // is `roost published — v4 (uploaded … of …)`. Anchor on the version label
  // since the byte counts depend on whether the upload phase actually ran.
  await expect(page.getByText(/roost published.*v4/i)).toBeVisible({ timeout: 10_000 });

  // List-row badge re-renders to v4.
  await expect(row.locator('[aria-label^="current version"]')).toHaveText('v4', {
    timeout: 5_000,
  });

  // VersionHistory re-fetches (refreshKey bumps after upload success).
  // #4 should now be the head row with the current-version marker.
  const versionRows = page.getByTestId('roost-version-row');
  const versionNumbers = versionRows.locator('span.font-mono', { hasText: /^#\d+$/ });
  await expect(versionNumbers.first()).toHaveText('#4', { timeout: 5_000 });
  await expect(versionRows.getByLabel('current version')).toHaveCount(1);

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
