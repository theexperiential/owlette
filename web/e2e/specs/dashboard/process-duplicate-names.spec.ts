/**
 * Duplicate process names — the gate in `web/lib/processConfig.server.ts`.
 *
 * Agent-synced configs legitimately carry duplicate names: the desktop app never
 * validated them, so a machine paired from an older install arrives with two
 * `untitled process` rows. The transactional gate therefore rejects only a
 * mutation that INTRODUCES or WORSENS a collision — a pre-existing one must not
 * 409 an unrelated save, which is exactly the field bug this file pins.
 *
 * Fixture: a config whose list already holds two `untitled process` rows plus a
 * distinct `touch`.
 *   1. renaming `touch` (untouched collision) → saves
 *   2. renaming `touch` INTO the collision → 409, surfaced in the UI
 *   3. renaming one duplicate to a unique name (cleanup) → saves
 *   4. creating a process with an existing name → 409, surfaced in the UI
 *
 * As in `process-config-roundtrip.spec.ts`, the dashboard renders names from the
 * status doc, so rows keep their seeded labels after a successful rename — every
 * locator uses the SEEDED name.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  configProcessById,
  configProcessNames,
  machineCard,
  pinDashboardContext,
  processEditButton,
  processRow,
  readConfigProcesses,
  seedMachineWithProcesses,
  toasts,
  type SeedProcess,
} from '../../helpers/processConfig';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-process-dupnames';

const UNTITLED = 'untitled process';
const UNTITLED_A_ID = 'proc-untitled-a';
const UNTITLED_B_ID = 'proc-untitled-b';
const TOUCH_ID = 'proc-touch';
const TOUCH_NAME = 'touch';

const SEEDED_PROCESSES: SeedProcess[] = [
  { id: UNTITLED_A_ID, name: UNTITLED, exe_path: 'C:\\seed\\untitled-a.exe' },
  { id: UNTITLED_B_ID, name: UNTITLED, exe_path: 'C:\\seed\\untitled-b.exe' },
  { id: TOUCH_ID, name: TOUCH_NAME, exe_path: 'C:\\seed\\touch.exe' },
];

/** The 409 detail is `Duplicate process name: <name>`; match loosely on the noun. */
const DUPLICATE_ERROR = /duplicate/i;

test.beforeEach(async () => {
  await pinDashboardContext(TEST_USERS.admin.uid, SITE_ID);
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, SEEDED_PROCESSES);
});

/** Open the edit dialog for a seeded row. `occurrence` disambiguates duplicate names. */
async function openEditDialog(
  page: Page,
  processName: string,
  occurrence = 0,
): Promise<Locator> {
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();
  await processEditButton(processRow(card, processName).nth(occurrence)).click();

  const dialog = page.getByRole('dialog', { name: /^edit process$/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#edit-name')).toHaveValue(processName);
  return dialog;
}

test('renaming an unrelated process saves even though the list already holds duplicates', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, TOUCH_NAME);

  await dialog.locator('#edit-name').fill('touchdesigner.exe');
  await dialog.getByRole('button', { name: /^save changes$/i }).click();
  await expect(dialog).toBeHidden();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(configProcessById(processes, TOUCH_ID).name).toBe('touchdesigner.exe');
  // The pre-existing collision is left exactly as the agent wrote it.
  expect(configProcessNames(processes)).toEqual([UNTITLED, UNTITLED, 'touchdesigner.exe']);
});

test('renaming a process into the existing collision is rejected and surfaced in the UI', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const dialog = await openEditDialog(page, TOUCH_NAME);

  await dialog.locator('#edit-name').fill(UNTITLED);
  await dialog.getByRole('button', { name: /^save changes$/i }).click();

  // 409 `duplicate_process_name`; the hook rethrows and the page toasts `detail`.
  await expect(toasts(page).filter({ hasText: DUPLICATE_ERROR })).toBeVisible();
  // The dialog stays open on failure so the name can be corrected.
  await expect(dialog).toBeVisible();

  // Nothing was written — the transaction threw before the update.
  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(configProcessNames(processes)).toEqual([UNTITLED, UNTITLED, TOUCH_NAME]);
});

test('renaming one of the duplicates to a unique name clears the collision', async ({ page }) => {
  await page.goto('/dashboard');
  // Rows render in config order, so occurrence 0 is the first `untitled process`.
  const dialog = await openEditDialog(page, UNTITLED, 0);

  await dialog.locator('#edit-name').fill('untitled process 1');
  await dialog.getByRole('button', { name: /^save changes$/i }).click();
  await expect(dialog).toBeHidden();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(configProcessById(processes, UNTITLED_A_ID).name).toBe('untitled process 1');
  expect(configProcessById(processes, UNTITLED_B_ID).name).toBe(UNTITLED);
  expect(configProcessNames(processes)).toEqual(['untitled process 1', UNTITLED, TOUCH_NAME]);
});

test('creating a process with a name already in use is rejected and surfaced in the UI', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const card = machineCard(page, MACHINE_ID);
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /^add process$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^add process$/i });
  await expect(dialog).toBeVisible();

  await dialog.locator('#edit-name').fill(TOUCH_NAME);
  await dialog.locator('#edit-exe-path').fill('C:\\apps\\touch\\Touch.exe');
  await dialog.getByRole('button', { name: /^create process$/i }).click();

  await expect(toasts(page).filter({ hasText: DUPLICATE_ERROR })).toBeVisible();
  await expect(dialog).toBeVisible();

  const processes = await readConfigProcesses(SITE_ID, MACHINE_ID);
  expect(processes).toHaveLength(3);
  expect(configProcessNames(processes)).toEqual([UNTITLED, UNTITLED, TOUCH_NAME]);
});
