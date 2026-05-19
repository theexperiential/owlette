import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the marketing screenshot pipeline.
 *
 * Separate from `playwright.config.ts` (the regression e2e suite) because:
 *   - testDir is `./e2e/screenshots` (not `./e2e/specs`)
 *   - workers: 1 (serialized — every scenario calls resetAndReseedBaseline
 *     which clears the auth + firestore emulator, so parallel workers wipe
 *     each other's seed data mid-test)
 *   - retries: 0 (failures should be loud — screenshot output must be deterministic)
 *   - chromium-only with a 1280×720 default viewport (capability previews
 *     are sized to display compactly inside the landing page card grid).
 *     `dashboard.spec.ts` overrides up to 2400×1300 since the hero treatment
 *     wants more density.
 *
 * Specs themselves call `page.screenshot({ path: 'public/landing-screens/X.png' })`
 * to write PNGs into `web/public/landing-screens/`. The `outputDir` below is only
 * for incidental Playwright test artifacts (traces, etc.) on failure.
 *
 * Reuses the regression suite's emulator boot + global-setup + webServer block so
 * specs get the same seeded users, sites, and storageState fixtures.
 *
 * Triggered by an explicit npm script (added in task 4.5); not in CI by default.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const NEXT_DIST_DIR = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';
const OUTPUT_DIR = process.env.E2E_SCREENSHOTS_OUTPUT_DIR || './e2e/.output/screenshots-results';

export default defineConfig({
  testDir: './e2e/screenshots',
  // Incidental Playwright artifacts (traces on failure, etc.) — NOT the
  // marketing PNGs. Specs write those directly to `public/landing-screens/`
  // via `page.screenshot({ path: ... })`.
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  // Screenshot generation must be deterministic. A retry that produces a
  // different pixel-perfect output silently is worse than a loud failure.
  retries: 0,
  workers: 1,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // No screenshot-on-failure here — specs explicitly screenshot to
    // `public/landing-screens/` and Playwright's failure screenshot would
    // collide / pollute the output.
    screenshot: 'off',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    viewport: { width: 1280, height: 720 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],

  webServer: {
    command: `node scripts/e2e-next-server.mjs --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-playwright-e2e.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-playwright-e2e.firebasestorage.app',
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: FIRESTORE_EMULATOR_HOST,
      NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
      FIRESTORE_EMULATOR_HOST,
      FIREBASE_STORAGE_EMULATOR_HOST: STORAGE_EMULATOR_HOST,
      FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      OWLETTE_NEXT_DIST_DIR: NEXT_DIST_DIR,
      SESSION_SECRET: 'demo-session-secret-for-emulator-playwright-tests-32chars',
      MFA_ENCRYPTION_KEY: 'demo-mfa-encryption-secret-for-playwright-only',
      NEXT_PUBLIC_SENTRY_DSN: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      E2E_DISABLE_RATE_LIMIT: 'true',
      OWLETTE_E2E: '1',
    },
  },
});
