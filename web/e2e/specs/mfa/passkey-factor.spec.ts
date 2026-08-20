/**
 * MFA — a passkey as a first-class second factor.
 *
 * Universal 2FA's central claim is that a passkey IS a second factor: one
 * user-verified ceremony enrolls it, one user-verified ceremony signs in with
 * it (no /verify-2fa detour), it can step up an already-signed-in session, and
 * removing it — even as the last factor — is allowed and re-arms mandatory
 * setup. Nothing in the suite exercised any of that until this spec: the older
 * `specs/account/passkeys.spec.ts` deliberately asserts only the UI shell and
 * documents the WebAuthn gap it left behind.
 *
 * ── HOW THIS FILE DIFFERS FROM EVERY OTHER SPEC ────────────────────────────
 *
 * `helpers/webauthn.ts` states the two rules and why; both apply here in full:
 *
 *   1. Every navigation uses an ABSOLUTE `WEBAUTHN_BASE_URL` (`localhost`) URL
 *      via `url()` below — never a relative path, which would resolve against
 *      the suite-wide `127.0.0.1` baseURL and put the browser on an origin
 *      whose RP ID no longer matches the ceremony's.
 *   2. `storageState` is emptied and every test signs in for itself, because
 *      the `fixtures/*.json` role sessions are cookie-bound to `127.0.0.1`.
 *
 * The virtual authenticator's defaults matter as much: `hasUserVerification`,
 * `isUserVerified` and `automaticPresenceSimulation` are all on, because every
 * ceremony in this codebase runs `userVerification: 'required'` — an
 * authenticator that cannot set the `uv` flag would be rejected by the server
 * rather than merely left unattended.
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
 * The virtual authenticator for the test currently running. Held at module
 * scope so `afterEach` can detach it even when the test failed mid-ceremony —
 * the helper's `remove()` is idempotent, and a leaked authenticator would sit
 * on the browser context and answer the NEXT spec's ceremonies.
 */
let virtualAuthenticator: VirtualAuthenticator | null = null;

/**
 * Turn OFF WebAuthn conditional UI (autofill) for every page in this spec.
 *
 * /login starts a passive `startAuthentication({ useBrowserAutofill: true })`
 * ceremony on mount whenever `browserSupportsWebAuthnAutofill()` resolves true,
 * and that promise sits pending until a credential is chosen. A CDP virtual
 * authenticator with `automaticPresenceSimulation` is precisely a thing that
 * chooses one without being asked — so a conditional run could sign the user in
 * the moment /login painted. That breaks two tests in opposite directions: the
 * explicit "continue with passkey" button would be gone before it was clicked,
 * and the step-up test's deliberate PASSWORD sign-in would silently become a
 * passkey sign-in, skipping the very /verify-2fa challenge it exists to assert.
 *
 * `browserSupportsWebAuthnAutofill()` is a single call to
 * `PublicKeyCredential.isConditionalMediationAvailable()`, so answering `false`
 * there keeps the page on its explicit-button path — the same path a browser
 * without conditional UI takes. Nothing else in the ceremony is stubbed: the
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
    // The context may already be torn down on a failed test; detaching a dead
    // CDP session throws and would mask the real failure.
    await attached.remove().catch(() => undefined);
  }
});

async function attachAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  virtualAuthenticator = await addVirtualAuthenticator(page);
  return virtualAuthenticator;
}

/**
 * A brand-new signup, in the state `bootstrapUser.server.ts` leaves one in:
 * zero factors and `requiresMfaSetup` armed, so the proxy sends the first
 * protected navigation to /setup-2fa.
 *
 * Seeded rather than driven through /register on purpose — the signup form is
 * already covered by `specs/auth/signup.spec.ts`, and re-running it here would
 * add a Turnstile round-trip to a spec whose subject starts at the chooser.
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
 * A password user who already holds TOTP. `mfaSecret` is written in the legacy
 * plaintext shape (no `:` separator) that `mfaProof.server.ts` and the
 * verify-login route both still accept — the same shortcut
 * `setup-verify.spec.ts` takes, and the only one available without importing
 * the server-side encryption module into a spec.
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
  // Landing page or /login — both are "signed out"; the exact target is
  // `specs/auth/logout.spec.ts`'s business, not this spec's.
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
 * Watch every main-frame navigation for a /verify-2fa detour.
 *
 * A `toHaveURL` assertion at the end cannot see a challenge page that was
 * shown and then left — which is exactly the regression the one-ceremony claim
 * is about — so the listener has to be armed before the sign-in starts.
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
 * Poll the denormalized inventory rather than reading it once: the wizard's UI
 * transition is driven by the register/verify response, and asserting on all
 * four fields together is what proves `applyMfaFactorChange` wrote a coherent
 * record rather than half of one.
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

  // Mandatory setup: the proxy turns the post-login /dashboard push into
  // /setup-2fa, so the chooser is where a fresh signup actually lands.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });

  await createPasskeyFromChooser(page);

  // The ceremony really ran against the e2e RP — not a UI state flipped by a
  // stubbed response.
  await expectCredentialCreated(virtual);
  expect(await passkeyDocIds(user.uid)).toHaveLength(1);

  // `applyMfaFactorChange` is the sole writer of all three fields, and the
  // passkey leg is recounted from the subcollection inside the transaction.
  await expectInventory(user.uid, {
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 1 },
  });

  // A passkey-only account can still mint recovery codes: `/api/mfa/backup-codes`
  // demands live proof of possession and accepts a UV assertion as one, which is
  // the second prompt this step names before it appears.
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

  // Arrange: the same enrollment as the test above, minus the assertions it
  // owns. The credential has to be minted by a real ceremony on this browser
  // context — a seeded Firestore document has no private key to assert with.
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

  // Act: sign in with the passkey alone. `mfaEnrolled` is true for this
  // account, so the session is born `mfaRequired` — the whole claim is that a
  // UV assertion also makes it born `mfaVerified`, in the SAME ceremony.
  const sawVerify = trackVerifyDetour(page);
  await page.goto(url('/login'));
  await page.getByRole('button', { name: /continue with passkey/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(sawVerify(), 'a UV passkey sign-in must never pass through /verify-2fa').toBe(false);

  // And it stays that way: every load re-POSTs /api/auth/session, so a
  // `mfaSatisfiedBy` that failed to persist would surface on the next
  // navigation rather than on this one.
  await page.goto(url('/dashboard'));
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  expect(sawVerify(), 'the verified session must survive the next navigation').toBe(false);
});

test('a password user with TOTP + a passkey clears /verify-2fa by passkey step-up', async ({
  page,
}) => {
  const { user, secret } = await seedTotpUser(`passkey-stepup-${Date.now()}`);
  const virtual = await attachAuthenticator(page);

  // Arrange, part 1: clear the TOTP challenge. This is also what opens the
  // enrollment gate — a second factor may only be added by a session that has
  // already proved the first.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  await fillFreshTotp(page, secret);
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Arrange, part 2: add the passkey alongside TOTP.
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

  // Act: a fresh PASSWORD sign-in is challenged as usual — the passkey is a
  // factor here, not the credential that signed in — and the challenge is
  // answered with it instead of a code.
  await signInWithPassword(page, user);
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });

  await page.getByRole('button', { name: /use a passkey/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // Step-up proves a factor for the session that already exists; it must not
  // enroll, remove or otherwise disturb the inventory.
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

  // DELETE is issued through `page.request`, which shares this context's cookie
  // jar — so it carries the very same `__session` the UI would send. The
  // account-settings route to the same call is PasskeyManager's trash control,
  // an icon-only <Button> carrying no accessible name; addressing it would mean
  // either a brittle svg-class locator or editing a component this task does
  // not own. What is under test here is the removal CONTRACT — allowed, even
  // for the last factor — not the icon.
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

  // Re-armed setup is not just a flag: the account is put straight back into
  // mandatory enrollment. AuthContext's user-document listener sees
  // `requiresMfaSetup` flip and the dashboard sends them to the chooser; the
  // full navigation also refreshes the session cookie, after which the proxy
  // enforces it server-side too.
  await page.goto(url('/dashboard'));
  await expect(page).toHaveURL(/\/setup-2fa/, { timeout: 20_000 });
});
