import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

test('setup-2fa generates a manual secret, verifies TOTP, and shows backup codes', async ({ page }) => {
  const user = await seedDedicatedUser(dedicatedUser('member', `mfa-setup-${Date.now()}`));

  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await page.goto('/setup-2fa');
  await expect(page.getByText(/set up two-factor authentication/i).first()).toBeVisible();
  await expect(page.getByAltText(/2FA QR Code/i)).toBeVisible();
  const secret = await page.locator('input[readonly]').inputValue();
  expect(secret.length).toBeGreaterThan(10);

  await page.getByRole('button', { name: /continue to verification/i }).click();
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: /verify & enable 2FA/i }).click();

  await expect(page.getByText(/save backup codes/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /continue to dashboard/i })).toBeVisible();
});

test('verify-2fa accepts enrolled-user TOTP with trust-device option', async ({ page }) => {
  const suffix = `mfa-login-${Date.now()}`;
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  const secret = authenticator.generateSecret();
  const backupCode = 'ABCDEF12';
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: secret,
      backupCodes: [crypto.createHash('sha256').update(backupCode).digest('hex')],
    },
    { merge: true },
  );

  await signIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await expect(page.getByText(/two-factor authentication/i).first()).toBeVisible();
  await page.getByLabel(/trust this device/i).click();
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
});
