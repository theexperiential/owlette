/**
 * Playwright global-setup — runs once before any spec.
 *
 *   1. Wait until emulators + web dev server are reachable (firebase emulators:exec
 *      + Playwright webServer handle the actual startup; we just sanity-ping).
 *   2. Reset all emulator state (fresh tests every run).
 *   3. Seed three canonical users + two sites via Admin SDK.
 *   4. For each role: launch a chromium context, sign in via the web app,
 *      capture storageState (cookies + localStorage + IndexedDB for Firebase
 *      client auth state), write to e2e/fixtures/{role}.json.
 *
 * Each spec then uses `test.use({ storageState: 'fixtures/{role}.json' })` to
 * boot pre-authenticated — no login traffic during the actual test run.
 */

import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  AUTH_EMULATOR_URL,
  FIRESTORE_EMULATOR_URL,
  E2E_BASE_URL,
  resetEmulators,
} from './helpers/emulator';
import { TEST_USERS, TestRole, seedBaseline } from './helpers/seed';

const FIXTURES_DIR = join(__dirname, 'fixtures');

async function waitForUrl(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // any response means the service is up
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for ${label} at ${url} (${timeoutMs}ms). Last error: ${lastErr}`,
  );
}

async function captureStorageStateForRole(role: TestRole): Promise<void> {
  const user = TEST_USERS[role];
  const fixturePath = join(FIXTURES_DIR, `${role}.json`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: E2E_BASE_URL });
    const page = await context.newPage();

    // Forward all browser-side console + error messages so login failures are
    // diagnosable from the global-setup log.
    page.on('console', (msg) => {
      console.log(`[global-setup][${role}][console.${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.warn(`[global-setup][${role}][pageerror] ${err.message}`);
    });
    page.on('requestfailed', (req) => {
      console.warn(
        `[global-setup][${role}][requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`,
      );
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    // Fill + submit the email/password login form.
    // Selectors chosen to be resilient to minor copy changes.
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();

    // Wait until we're on a post-login surface. Any of: /dashboard, /setup-2fa,
    // /verify-2fa, or the user-menu chevron becoming visible.
    // MFA should be pre-bypassed by the seed (mfaEnrolled=false, requiresMfaSetup=false).
    try {
      await page.waitForURL(
        (url) => {
          const p = url.pathname;
          return p.startsWith('/dashboard') || p.startsWith('/setup-2fa') || p.startsWith('/verify-2fa');
        },
        { timeout: 20_000 },
      );
    } catch (err) {
      // On navigation timeout, capture everything we can for post-mortem.
      const debugDir = join(FIXTURES_DIR, '..', 'debug');
      if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
      const screenshotPath = join(debugDir, `login-failure-${role}.png`);
      const htmlPath = join(debugDir, `login-failure-${role}.html`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const html = await page.content();
      await import('fs').then((fs) => fs.promises.writeFile(htmlPath, html, 'utf8'));
      console.error(`[global-setup][${role}] login navigation timed out.`);
      console.error(`  current URL: ${page.url()}`);
      console.error(`  screenshot:  ${screenshotPath}`);
      console.error(`  html:        ${htmlPath}`);
      throw err;
    }

    // If we landed on an MFA page, the seed is misconfigured for this user.
    // Fail loudly so we don't silently capture a state that redirects on every spec.
    const currentUrl = page.url();
    if (currentUrl.includes('/setup-2fa') || currentUrl.includes('/verify-2fa')) {
      throw new Error(
        `[${role}] post-login landed on ${currentUrl} — seed/MFA bypass misconfigured. ` +
          `Verify users/${user.uid}.requiresMfaSetup === false and .mfaEnrolled === false.`,
      );
    }

    // Give the AuthContext listener + session cookie round-trip a moment to settle.
    await page.waitForTimeout(1_000);

    // Capture cookies + localStorage + IndexedDB (the last is where Firebase
    // client auth state lives — requires Playwright ≥1.51 + indexedDB:true).
    await context.storageState({ path: fixturePath, indexedDB: true });
    console.log(`[global-setup] captured storageState for ${role} → ${fixturePath}`);
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });

  console.log('[global-setup] waiting for emulators + web server...');
  await Promise.all([
    waitForUrl(`${AUTH_EMULATOR_URL}/`, 'Auth emulator'),
    waitForUrl(`${FIRESTORE_EMULATOR_URL}/`, 'Firestore emulator'),
    waitForUrl(E2E_BASE_URL, 'web server'),
  ]);

  console.log('[global-setup] resetting emulators...');
  await resetEmulators();

  console.log('[global-setup] seeding baseline (users + sites)...');
  await seedBaseline();

  console.log('[global-setup] capturing storageState per role...');
  for (const role of ['member', 'admin', 'superadmin'] as const) {
    await captureStorageStateForRole(role);
  }

  console.log('[global-setup] done.');
}
