/**
 * WebAuthn virtual-authenticator harness (Chromium/CDP).
 *
 * Chromium exposes a fully software authenticator through the CDP `WebAuthn`
 * domain, so a spec can drive a real registration or assertion ceremony —
 * `navigator.credentials.create()` / `.get()`, the real
 * `@simplewebauthn/browser` calls, the real server verification — with no
 * hardware, no OS prompt, and no user gesture.
 *
 * ── TWO RULES FOR EVERY CONSUMING SPEC ─────────────────────────────────────
 *
 * 1. Navigate with ABSOLUTE `WEBAUTHN_BASE_URL` URLs, never with the relative
 *    paths the rest of the suite uses.
 * 2. Declare `test.use({ storageState: { cookies: [], origins: [] } })` and log
 *    in inside the spec — do NOT use `roleState(...)`.
 *
 * Both follow from one constraint: an IP literal is not a valid WebAuthn RP ID,
 * so the harness pins the RP to `localhost` (see `WEBAUTHN_RP_ID` /
 * `WEBAUTHN_ORIGINS` in `web/playwright.config.ts`, consumed by
 * `web/lib/webauthn.server.ts`). The rest of the suite runs against the
 * `127.0.0.1` `baseURL`, and the role fixtures in `web/e2e/fixtures/*.json` are
 * cookie-bound to that host. `localhost` and `127.0.0.1` are the same server but
 * different origins to the browser, so a fixture's session cookie is simply not
 * sent here — a spec that loads one and then navigates relatively lands on
 * `127.0.0.1`, where the ceremony's RP ID no longer matches and the browser
 * rejects it before any request is made.
 *
 * The e2e server serves a PRODUCTION Next build, which is why the RP override
 * exists at all; `web/lib/webauthn.server.ts` documents that in full.
 */

import { expect, type CDPSession, type Page } from '@playwright/test';
import { E2E_PORT } from './emulator';

/**
 * Origin every WebAuthn spec must navigate to. Deliberately `localhost` rather
 * than the `127.0.0.1` of the suite-wide `baseURL` — see the file header.
 */
export const WEBAUTHN_BASE_URL = `http://localhost:${E2E_PORT}`;

/** RP ID the harness authenticates against; mirrors `WEBAUTHN_RP_ID`. */
export const WEBAUTHN_RP_ID = 'localhost';

export interface VirtualAuthenticatorOptions {
  /**
   * `internal` models a platform authenticator (Windows Hello, Touch ID, a
   * password manager); `usb` models a roaming security key. Defaults to
   * `internal`.
   */
  transport?: 'internal' | 'usb';
  /**
   * Discoverable (resident) credentials, which usernameless login and
   * conditional-UI autofill both require. On by default.
   */
  hasResidentKey?: boolean;
  /** Authenticator is capable of user verification. On by default. */
  hasUserVerification?: boolean;
  /**
   * UV succeeds without a prompt — this is what makes the ceremony set the `uv`
   * flag, which the server pins via `requireUserVerification`. On by default;
   * set false to exercise a UV failure.
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
 * Attach a virtual authenticator to `page`'s browser context.
 *
 * Call this BEFORE the navigation that runs the ceremony. The authenticator
 * lives on the browser context, so it survives navigations within the spec, but
 * it must be removed (or the context closed) before the next spec runs.
 */
export async function addVirtualAuthenticator(
  page: Page,
  opts: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  // enableUI: false — the real Chromium account picker would need a click no
  // automated spec can make.
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
 * Assert the ceremony actually minted a credential, and hand it back.
 *
 * Polled rather than read once: `navigator.credentials.create()` resolves in the
 * page and the app then POSTs the attestation, so a straight read right after
 * the UI settles can race the authenticator's own bookkeeping.
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
