/**
 * WebAuthn virtual-authenticator harness (Chromium/CDP) — drives real
 * registration/assertion ceremonies with no hardware, OS prompt or user gesture.
 *
 * TWO RULES FOR EVERY CONSUMING SPEC:
 * 1. Navigate with ABSOLUTE `WEBAUTHN_BASE_URL` URLs, never relative paths.
 * 2. `test.use({ storageState: { cookies: [], origins: [] } })` and log in
 *    inside the spec — do NOT use `roleState(...)`.
 *
 * Both follow from one constraint: an IP literal is not a valid RP ID, so the
 * RP is pinned to `localhost` while the rest of the suite runs on `127.0.0.1`.
 * Same server, different browser origins — fixture cookies are not sent here,
 * and a relative navigation lands on `127.0.0.1` where the RP ID no longer
 * matches and the browser rejects the ceremony before any request.
 */

import { expect, type CDPSession, type Page } from '@playwright/test';
import { E2E_PORT } from './emulator';

/** Origin every WebAuthn spec must navigate to — `localhost`, not the suite's
 *  `127.0.0.1` baseURL. See the file header. */
export const WEBAUTHN_BASE_URL = `http://localhost:${E2E_PORT}`;

/** RP ID the harness authenticates against; mirrors `WEBAUTHN_RP_ID`. */
export const WEBAUTHN_RP_ID = 'localhost';

export interface VirtualAuthenticatorOptions {
  /** `internal` = platform authenticator, `usb` = roaming key. Default internal. */
  transport?: 'internal' | 'usb';
  /** Discoverable credentials, required by usernameless login and autofill. Default on. */
  hasResidentKey?: boolean;
  /** Authenticator is capable of user verification. On by default. */
  hasUserVerification?: boolean;
  /**
   * UV succeeds without a prompt, so the ceremony sets the `uv` flag the server
   * pins via `requireUserVerification`. Default on; false exercises UV failure.
   */
  isUserVerified?: boolean;
  /** Touch/presence resolves immediately instead of hanging. On by default. */
  automaticPresenceSimulation?: boolean;
  /** BE flag on created credentials — drives the stored `backedUp` field. */
  defaultBackupEligibility?: boolean;
  /** BS flag on created credentials — drives the stored `backedUp` field. */
  defaultBackupState?: boolean;
}

/** The subset of a virtual credential a spec has any business asserting on. */
export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  userHandle?: string;
  userName?: string;
  signCount: number;
}

export interface VirtualAuthenticator {
  /** CDP-assigned id; only needed for raw `cdp.send(...)` calls. */
  authenticatorId: string;
  /** The attached session, exposed for CDP calls this helper doesn't wrap. */
  cdp: CDPSession;
  /** Everything the authenticator currently holds. */
  credentials(): Promise<VirtualCredential[]>;
  /** Detach the authenticator. Idempotent, so it is safe in an afterEach. */
  remove(): Promise<void>;
}

/**
 * Attach a virtual authenticator to `page`'s browser context. Call BEFORE the
 * navigation that runs the ceremony; it survives navigations but must be
 * removed (or the context closed) before the next spec.
 */
export async function addVirtualAuthenticator(
  page: Page,
  opts: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  // enableUI: false — the real account picker needs a click no spec can make.
  await cdp.send('WebAuthn.enable', { enableUI: false });

  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: opts.transport ?? 'internal',
      hasResidentKey: opts.hasResidentKey ?? true,
      hasUserVerification: opts.hasUserVerification ?? true,
      isUserVerified: opts.isUserVerified ?? true,
      automaticPresenceSimulation: opts.automaticPresenceSimulation ?? true,
      defaultBackupEligibility: opts.defaultBackupEligibility ?? true,
      defaultBackupState: opts.defaultBackupState ?? true,
    },
  });

  let removed = false;

  return {
    authenticatorId,
    cdp,
    async credentials(): Promise<VirtualCredential[]> {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials.map((c) => ({
        credentialId: c.credentialId,
        isResidentCredential: c.isResidentCredential,
        rpId: c.rpId,
        userHandle: c.userHandle,
        userName: c.userName,
        signCount: c.signCount,
      }));
    },
    async remove(): Promise<void> {
      if (removed) {
        return;
      }
      removed = true;
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await cdp.detach();
    },
  };
}

export interface ExpectCredentialOptions {
  /** How many credentials the authenticator should hold. Defaults to 1. */
  count?: number;
  /** RP the credential must be scoped to. Defaults to `WEBAUTHN_RP_ID`. */
  rpId?: string;
  /** Poll ceiling in ms. Defaults to 10s, matching `expect.timeout`. */
  timeout?: number;
}

/**
 * Assert the ceremony minted a credential, and hand it back. Polled, not read
 * once: a straight read after the UI settles races the authenticator's own
 * bookkeeping.
 */
export async function expectCredentialCreated(
  authenticator: VirtualAuthenticator,
  opts: ExpectCredentialOptions = {},
): Promise<VirtualCredential[]> {
  const expectedCount = opts.count ?? 1;
  const expectedRpId = opts.rpId ?? WEBAUTHN_RP_ID;

  await expect
    .poll(async () => (await authenticator.credentials()).length, {
      message: `virtual authenticator should hold ${expectedCount} credential(s)`,
      timeout: opts.timeout ?? 10_000,
    })
    .toBe(expectedCount);

  const credentials = await authenticator.credentials();
  for (const credential of credentials) {
    expect(credential.rpId, 'credential should be scoped to the e2e RP').toBe(expectedRpId);
  }
  return credentials;
}
