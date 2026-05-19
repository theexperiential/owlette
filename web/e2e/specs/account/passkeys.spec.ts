/**
 * Account — passkeys UI shell (C4.3)
 *
 * Per the plan's fallback guidance ("skip if too complex, fall back to
 * assertion that the UI renders"), this spec does NOT exercise the
 * actual WebAuthn ceremony — `navigator.credentials.create()` requires
 * a virtual authenticator installed via CDP, our backend routes want
 * real attestation, and mocking all of that end-to-end is a multi-day
 * lift that doesn't earn its keep until we're actively changing passkey
 * code.
 *
 * What this spec DOES cover (the UX surface that can break regardless
 * of WebAuthn plumbing):
 *   - seeded member (passkeyEnrolled=false, per `seed.ts`) sees the
 *     empty-state copy "no passkeys registered yet."
 *   - the "add passkey" button renders
 *   - clicking it reveals the name input AND the button flips to
 *     "register passkey" — proves the two-step toggle contract
 *
 * WebAuthn coverage gap acknowledged in the log; revisit when a
 * passkey change ships.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('member'));

test('passkey section shows empty state and the "add passkey" toggle expands correctly', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^security$/i }).first().click();

  // PasskeyManager renders a "passkeys" section title (CardTitle).
  await expect(page.getByText('passkeys', { exact: true }).first()).toBeVisible();

  // Seeded member has no passkeys — empty-state copy is visible.
  await expect(page.getByText('no passkeys registered yet.', { exact: true })).toBeVisible();

  // Collapsed state: the add-passkey button renders.
  const addButton = page.getByRole('button', { name: /^add passkey$/i });
  await expect(addButton).toBeVisible();

  // Click once → reveals the name input and relabels the CTA to
  // "register passkey" (per PasskeyManager.handleRegister: the first
  // click with !showNameInput just opens the input).
  await addButton.click();

  await expect(page.getByPlaceholder('passkey name (e.g. MacBook, iPhone)')).toBeVisible();
  await expect(page.getByRole('button', { name: /^register passkey$/i })).toBeVisible();
  // Original "add passkey" button is gone now (same element, relabelled).
  await expect(page.getByRole('button', { name: /^add passkey$/i })).toHaveCount(0);
});
