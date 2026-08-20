/**
 * Account — passkeys UI shell. Deliberately does NOT run the WebAuthn ceremony
 * (see `e2e/helpers/webauthn.ts` for the harness that does); this covers only
 * the UX surface that breaks independently of the plumbing: the empty state,
 * the "add passkey" button, and the two-step toggle to "register passkey".
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

  // First click only opens the input and relabels the CTA — see
  // PasskeyManager.handleRegister's !showNameInput branch.
  await addButton.click();

  await expect(page.getByPlaceholder('passkey name (e.g. MacBook, iPhone)')).toBeVisible();
  await expect(page.getByRole('button', { name: /^register passkey$/i })).toBeVisible();
  // Original "add passkey" button is gone now (same element, relabelled).
  await expect(page.getByRole('button', { name: /^add passkey$/i })).toHaveCount(0);
});
