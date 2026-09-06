/**
 * Sites — create-site dialog (C2.1)
 *
 * Superadmin: site switcher → "manage sites" → "new site" → custom site ID + name →
 * submit. Verifies the "created successfully" toast, the site appearing in the switcher
 * dropdown, and sites/{id} in Firestore with owner set to the creator's uid, a
 * populated timezone, and `schedulesFollowSiteTime: true` — new sites are born on site
 * time (wave 3b), and this is the only end-to-end proof that the dialog's flag survives
 * the hook, the POST body and the create action into the document.
 *
 * Edge case: reusing an existing site ID flips the availability indicator to "taken",
 * surfaces the error text, and keeps the submit button disabled.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

// Seed a site with an all-lowercase ID the validator accepts. The baseline
// fixture's `site-A` / `site-B` use an uppercase letter, which the input
// normalizer downcases — so typing them wouldn't match the seeded docs.
const EXISTING_SITE_ID = 'site-existing';

test.beforeAll(async () => {
  await seedSite({
    id: EXISTING_SITE_ID,
    name: 'Pre-seeded Site',
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

test('superadmin can create a new site via the switcher', async ({ page }) => {
  // Deterministic-unique ID: valid slug + timestamp so re-runs never collide.
  const stamp = Date.now();
  const newSiteId = `e2e-new-site-${stamp}`;
  const newSiteName = `E2E New Site ${stamp}`;

  await page.goto('/dashboard');

  // Open site switcher → "manage sites" → "new site".
  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: /manage sites/i }).click();
  await page.getByRole('dialog', { name: /manage sites/i })
    .getByRole('button', { name: 'new site', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  // Fill the name, then expand "customize site ID" and replace the auto-gen
  // slug with our deterministic one. The availability check is debounced 500ms,
  // so we assert via the enabled-state of the submit button (which goes active
  // only when availabilityStatus === 'available').
  await createDialog.getByLabel('site name').fill(newSiteName);
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(newSiteId);

  // The detected browser timezone is shown before anything is written — it is
  // the clock the new site's schedules will be read against.
  await expect(createDialog.getByTestId('create-site-timezone')).not.toBeEmpty();

  const submit = createDialog.getByRole('button', { name: /^create site$/i });
  await expect(submit).toBeEnabled({ timeout: 5_000 });
  await submit.click();

  // Success toast + dialog closes.
  await expect(page.getByText(/created successfully/i)).toBeVisible();
  await expect(createDialog).toBeHidden();

  // Site now appears in the switcher (onSiteCreated auto-switches currentSiteId
  // to the new one, so the trigger label should update).
  await expect(page.getByTestId('site-switcher-trigger')).toContainText(newSiteName);

  // Admin SDK read-through — the real contract assertion. Verifies the
  // createSite hook wrote the doc with the superadmin's uid as owner and
  // a non-empty timezone (populated from the browser on submit).
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(newSiteId).get();
  expect(snap.exists).toBe(true);
  const data = snap.data()!;
  expect(data.name).toBe(newSiteName);
  expect(data.owner).toBe('super-uid');
  expect(typeof data.timezone).toBe('string');
  expect(data.timezone.length).toBeGreaterThan(0);
  // Born opted in, and never with the flag alone: `true` without a timezone is
  // the one combination the site-time contract refuses.
  expect(data.schedulesFollowSiteTime).toBe(true);
});

test('create-site blocks submission when site ID is already taken', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: /manage sites/i }).click();
  await page.getByRole('dialog', { name: /manage sites/i })
    .getByRole('button', { name: 'new site', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: /create new site/i });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel('site name').fill('Collision Site');
  await createDialog.getByRole('button', { name: /customize site id/i }).click();
  await createDialog.locator('#site-id').fill(EXISTING_SITE_ID);

  // Debounced availability check resolves → "taken" → error text + disabled submit.
  await expect(createDialog.getByText(/already taken/i)).toBeVisible({ timeout: 5_000 });
  await expect(createDialog.getByRole('button', { name: /^create site$/i })).toBeDisabled();
});
