/**
 * MFA — a passkey as a first-class second factor: one UV ceremony enrolls it,
 * one signs in (no /verify-2fa detour), it can step up a live session, and
 * removing it — even as the last factor — re-arms mandatory setup.
 * (`specs/account/passkeys.spec.ts` covers only the UI shell.)
 *
 * Two rules from `helpers/webauthn.ts` apply in full here:
 *   1. Navigate via absolute `WEBAUTHN_BASE_URL` (`localhost`) URLs — a relative
 *      path resolves against the suite's `127.0.0.1` baseURL, whose origin no
 *      longer matches the ceremony's RP ID.
 *   2. `storageState` is emptied and each test signs in itself; the
 *      `fixtures/*.json` role sessions are cookie-bound to `127.0.0.1`.
 *
 * The authenticator keeps hasUserVerification/isUserVerified/
 * automaticPresenceSimulation on: every ceremony here uses
 * `userVerification: 'required'` and the server rejects a missing `uv` flag.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import type { TestUser } from '../../helpers/seed';
import {
  WEBAUTHN_BASE_URL,
  addVirtualAuthenticator,
  expectCredentialCreated,
  type VirtualAuthenticator,
} from '../../helpers/webauthn';

authenticator.options = { step: 30, window: 1 };

test.use({ storageState: { cookies: [], origins: [] } });

/** Absolute URL on the WebAuthn origin. See rule 1 in the file header. */
const url = (path: string) => `${WEBAUTHN_BASE_URL}${path}`;

/**
 * Module-scoped so `afterEach` can detach it even after a mid-ceremony failure;
 * a leaked authenticator would answer the next spec's ceremonies.
 */
let virtualAuthenticator: VirtualAuthenticator | null = null;

/**
 * Disable WebAuthn conditional UI (autofill) for every page in this spec.
 *
 * /login opens a passive autofill ceremony on mount, and a virtual authenticator
 * with `automaticPresenceSimulation` answers it unprompted — signing the user in
 * as soon as /login paints. That would delete the explicit "continue with
 * passkey" button before it is clicked and turn the step-up test's deliberate
 * PASSWORD sign-in into a passkey sign-in, skipping the /verify-2fa challenge.
 *
 * Stubbing `isConditionalMediationAvailable()` to false is the whole stub — the
 * real `navigator.credentials.get()` still runs against the real authenticator.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const pkc = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential as
      | { isConditionalMediationAvailable?: () => Promise<boolean> }
      | undefined;
    if (pkc) {
      pkc.isConditionalMediationAvailable = () => Promise.resolve(false);
    }
  });
});

test.afterEach(async () => {
  const attached = virtualAuthenticator;
  virtualAuthenticator = null;
  if (attached) {
    // Detaching a dead CDP session throws and would mask the real failure.
    await attached.remove().catch(() => undefined);
  }
});

async function attachAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  virtualAuthenticator = await addVirtualAuthenticator(page);
  return virtualAuthenticator;
}

/**
 * Brand-new signup as `bootstrapUser.server.ts` leaves it: zero factors,
 * `requiresMfaSetup` armed, so the proxy sends the first protected navigation to
 * /setup-2fa. Seeded rather than driven through /register to skip a Turnstile
 * round-trip (signup is covered by `specs/auth/signup.spec.ts`).
 */
async function seedPendingSetupUser(suffix: string): Promise<TestUser> {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: false,
      requiresMfaSetup: true,
      mfaFactors: { totp: false, passkeys: 0 },
    },
    { merge: true },
  );
  return user;
}

/**
 * Password user with TOTP. `mfaSecret` uses the legacy plaintext shape (no `:`)
 * that mfaProof.server and verify-login still accept — the only option without
 * importing the server-side encryption module into a spec.
 */
async function seedTotpUser(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  const secret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: secret,
      mfaFactors: { totp: true, passkeys: 0 },
      backupCodes: [crypto.createHash('sha256').update('ABCDEF12').digest('hex')],
    },
    { merge: true },
  );
  return { user, secret };
}

async function signInWithPassword(page: Page, user: TestUser) {
  await page.goto(url('/login'));
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

async function signOut(page: Page) {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  // Landing page or /login — both count as signed out; the exact target belongs
  // to `specs/auth/logout.spec.ts`.
  await expect(page).toHaveURL(/\/(login)?$/, { timeout: 20_000 });
}

async function fillFreshTotp(page: Page, secret: string) {
  const secondsUntilNextCode = authenticator.timeRemaining();
  if (secondsUntilNextCode <= 5) {
    await page.waitForTimeout((secondsUntilNextCode + 1) * 1000);
  }
  await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
}

/**
 * Watch every main-frame navigation for a /verify-2fa detour. A trailing
 * `toHaveURL` cannot see a challenge that was shown and then left — exactly the
 * regression at issue — so arm the listener before sign-in starts.
 */
function trackVerifyDetour(page: Page): () => boolean {
  let seen = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url().includes('/verify-2fa')) {
      seen = true;
    }
  });
  return () => seen;
}

/** Drive the /setup-2fa chooser's passkey branch as far as the credential. */
async function createPasskeyFromChooser(page: Page) {
  await expect(page.getByText(/choose your second factor/i)).toBeVisible();
  await page.getByRole('button', { name: /passkey/i }).first().click();
  await page.getByRole('button', { name: /^create passkey$/i }).click();
  await expect(page.getByText(/passkey added/i)).toBeVisible({ timeout: 20_000 });
}

interface FactorInventory {
  mfaEnrolled?: boolean;
  requiresMfaSetup?: boolean;
  mfaFactors?: { totp?: boolean; passkeys?: number };
}

/**
 * Poll the denormalized inventory (the wizard transitions off the register
 * response, not the write); asserting all four fields together is what proves
 * `applyMfaFactorChange` wrote a coherent record, not half of one.
 */
async function expectInventory(uid: string, expected: FactorInventory) {
  await expect
    .poll(
      async () => {
        const snap = await getAdminDb().collection('users').doc(uid).get();
        const data = (snap.data() ?? {}) as FactorInventory;
        return {
          mfaEnrolled: data.mfaEnrolled ?? false,
          requiresMfaSetup: data.requiresMfaSetup ?? false,
          totp: data.mfaFactors?.totp ?? false,
          passkeys: data.mfaFactors?.passkeys ?? 0,
        };
      },
      { message: `users/${uid} factor inventory`, timeout: 15_000 },
    )
    .toEqual({
      mfaEnrolled: expected.mfaEnrolled ?? false,
      requiresMfaSetup: expected.requiresMfaSetup ?? false,
      totp: expected.mfaFactors?.totp ?? false,
      passkeys: expected.mfaFactors?.passkeys ?? 0,
    });
}

async function passkeyDocIds(uid: string): Promise<string[]> {
  const snap = await getAdminDb().collection('users').doc(uid).collection('passkeys').get();
  return snap.docs.map((doc) => doc.id);
}

test('a new signup enrolls a passkey as its only factor and reaches the dashboard', async ({
  page,
}) => {
  const user = await seedPendingSetupUser(`passkey-enroll-${Date.now()}`);
  const virtual = await attachAuthenticator(page);

  // The proxy turns the post-login /dashboard push into /setup-2fa.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });

  await createPasskeyFromChooser(page);

  // The ceremony really ran against the e2e RP, not a stubbed response.
  await expectCredentialCreated(virtual);
  expect(await passkeyDocIds(user.uid)).toHaveLength(1);

  // `applyMfaFactorChange` is the sole writer of all three fields; the passkey
  // leg is recounted from the subcollection inside the transaction.
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 1 },
  });

  // Passkey-only accounts can still mint recovery codes: /api/mfa/backup-codes
  // demands live proof of possession and accepts a UV assertion (the 2nd prompt).
  await page.getByRole('button', { name: /get backup codes/i }).click();
  await expect(page.getByText(/save backup codes/i)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /continue to dashboard/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
});

test('signing in with that passkey lands on the dashboard with no /verify-2fa detour', async ({
  page,
}) => {
  const user = await seedPendingSetupUser(`passkey-login-${Date.now()}`);
  await attachAuthenticator(page);

  // Same enrollment as above, minus its assertions. The credential must be minted
  // by a real ceremony here — a seeded Firestore doc has no private key.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });
  await createPasskeyFromChooser(page);
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 1 },
  });
  await page.getByRole('button', { name: /skip for now/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await signOut(page);

  // The session is born `mfaRequired` (mfaEnrolled); the claim is that a UV
  // assertion makes it born `mfaVerified` in the SAME ceremony.
  const sawVerify = trackVerifyDetour(page);
  await page.goto(url('/login'));
  await page.getByRole('button', { name: /continue with passkey/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(sawVerify(), 'a UV passkey sign-in must never pass through /verify-2fa').toBe(false);

  // Every load re-POSTs /api/auth/session, so an unpersisted `mfaSatisfiedBy`
  // would surface on the next navigation.
  await page.goto(url('/dashboard'));
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(sawVerify(), 'the verified session must survive the next navigation').toBe(false);
});

test('a password user with TOTP + a passkey clears /verify-2fa by passkey step-up', async ({
  page,
}) => {
  const { user, secret } = await seedTotpUser(`passkey-stepup-${Date.now()}`);
  const virtual = await attachAuthenticator(page);

  // Clearing the TOTP challenge also opens the enrollment gate: a second factor
  // may only be added by a session that proved the first.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Add the passkey alongside TOTP.
  await page.goto(url('/setup-2fa'));
  await createPasskeyFromChooser(page);
  await expectCredentialCreated(virtual);
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: true, passkeys: 1 },
  });
  await page.getByRole('button', { name: /skip for now/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await signOut(page);

  // A fresh PASSWORD sign-in is challenged as usual, then answered with the
  // passkey instead of a code.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await page.getByRole('button', { name: /use a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Step-up must not enroll, remove or otherwise disturb the inventory.
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: true, passkeys: 1 },
  });
});

test('removing the last passkey succeeds and re-arms mandatory setup', async ({ page }) => {
  const user = await seedPendingSetupUser(`passkey-remove-${Date.now()}`);
  await attachAuthenticator(page);

  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });
  await createPasskeyFromChooser(page);
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 1 },
  });
  await page.getByRole('button', { name: /skip for now/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  const [credentialId] = await passkeyDocIds(user.uid);
  expect(credentialId, 'the enrolled credential id').toBeTruthy();

  // `page.request` shares the context cookie jar, so this DELETE carries the same
  // `__session` the UI would. The UI path is PasskeyManager's icon-only trash
  // button with no accessible name; the contract (removal allowed even for the
  // last factor) is what's under test, not the icon.
  const response = await page.request.delete(
    url(`/api/passkeys/${encodeURIComponent(credentialId)}?userId=${encodeURIComponent(user.uid)}`),
  );
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ success: true });

  expect(await passkeyDocIds(user.uid), 'the credential document is gone').toHaveLength(0);
  await expectInventory(user.uid, {
    mfaEnrolled: false,
    requiresMfaSetup: true,
    mfaFactors: { totp: false, passkeys: 0 },
  });

  // Re-arming is not just a flag: AuthContext's user-doc listener sees
  // `requiresMfaSetup` flip and the dashboard redirects to the chooser; the full
  // navigation refreshes the session cookie so the proxy enforces it too.
  await page.goto(url('/dashboard'));
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });
});
