/**
 * Playwright global-setup, once before any spec: sanity-ping the emulators and
 * dev server, reset emulator state, seed the canonical users + sites via the
 * Admin SDK, then sign each role in through the real web app and write its
 * storageState to `e2e/fixtures/{role}.json`.
 *
 * Specs `test.use({ storageState })` from there, so no login traffic runs
 * during the suite itself.
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

const FIXTURES_DIR = process.env.E2E_FIXTURES_DIR || join(__dirname, 'fixtures');

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

    // Forward browser console/errors so login failures show in this log.
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

    page.on('response', async (res) => {
      if (res.status() < 400) return;
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '<unreadable body>';
      }
      console.warn(
        `[global-setup][${role}][response.${res.status()}] ${res.request().method()} ${res.url()} ${body.slice(0, 500)}`,
      );
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    // Selectors deliberately loose so minor copy changes don't break setup.
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();

    // Any post-login surface: /dashboard, /setup-2fa, /verify-2fa, or the
    // user-menu chevron. The seed pre-bypasses MFA.
    try {
      await page.waitForURL(
        (url) => {
          const p = url.pathname;
          return p.startsWith('/dashboard') || p.startsWith('/setup-2fa') || p.startsWith('/verify-2fa');
        },
        { timeout: 20_000 },
      );
    } catch (err) {
      // Capture everything for post-mortem on a navigation timeout.
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

    // An MFA page means the seed is wrong — fail loudly rather than capture a
    // state that redirects in every spec.
    const currentUrl = page.url();
    if (currentUrl.includes('/setup-2fa') || currentUrl.includes('/verify-2fa')) {
      throw new Error(
        `[${role}] post-login landed on ${currentUrl} — seed/MFA bypass misconfigured. ` +
          `Verify users/${user.uid}.requiresMfaSetup === false and .mfaEnrolled === false.`,
      );
    }

    // Let the AuthContext listener + session-cookie round-trip settle.
    await page.waitForTimeout(1_000);

    // IndexedDB holds the Firebase client auth state — needs Playwright ≥1.51
    // and indexedDB:true.
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
