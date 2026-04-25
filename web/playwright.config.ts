import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration
 *
 * Runs the web app against Firebase emulators (Auth + Firestore + Storage)
 * on non-default ports so it can run alongside `npm run dev` on :3000.
 *
 * See dev/active/playwright-e2e/plan.md for the full strategy.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e/specs',
  // Cluster ephemeral output under e2e/.output/ instead of Playwright's
  // default web/test-results + web/playwright-report paths, which polluted
  // the top of web/ with two separate build-output dirs. Both are
  // gitignored via web/.gitignore.
  outputDir: './e2e/.output/results',
  fullyParallel: false, // Emulator state is shared across tests; serial keeps seeding deterministic.
  forbidOnly: IS_CI, // Fail CI if a test is .only()'d
  retries: IS_CI ? 2 : 0,
  workers: 1, // Single worker for now — emulator-seeded state can't be parallel-shared without more plumbing
  reporter: IS_CI
    ? [['list'], ['html', { open: 'never', outputFolder: './e2e/.output/report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: './e2e/.output/report' }]],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  use: {
    baseURL: BASE_URL,
    // Always capture traces + screenshots on failure for post-mortem.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Slightly larger than default; Firebase auth + Firestore roundtrips can take a second on cold emulator.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start the Next.js web server for the duration of the test run. Playwright
  // waits on `url` to return 200 before running tests.
  //
  // Env vars threaded in here drive the emulator branches in web/lib/firebase.ts
  // and web/lib/firebase-admin.ts — without them, the app hits real Firebase.
  webServer: {
    // Why `next start`, not `next dev`:
    //   Next 16 + Turbopack refuses to start a second `next dev` in the same
    //   project directory, even on different ports. `next start` doesn't have
    //   that concurrent-instance lock, so E2E can run alongside the user's
    //   `npm run dev`. The trade-off: a production build must exist in `.next/`
    //   before `next start` can boot. The top-level `npm run e2e` script
    //   handles the build step first.
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !IS_CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // Client-side: gate the connectXEmulator() calls in web/lib/firebase.ts
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key', // emulator accepts anything non-empty
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-playwright-e2e.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-playwright-e2e.firebasestorage.app',
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
      // Server-side: trigger the emulator branch in web/lib/firebase-admin.ts
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
      FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
      // Keep iron-session happy. Any 32+ char string works for emulator-only.
      SESSION_SECRET: 'demo-session-secret-for-emulator-playwright-tests-32chars',
      // Silence Sentry in test.
      NEXT_PUBLIC_SENTRY_DSN: '',
      // Disable Upstash-backed rate limiting. Without this override, the
      // webServer inherits UPSTASH_REDIS_REST_URL from .env.local and the
      // auth-session endpoint enforces a 10-per-minute limit per IP — which
      // rapid E2E runs (global-setup signs in 3 roles back-to-back, then
      // individual specs re-auth) can blow through, leaving global-setup to
      // time out on /login redirects. Empty strings short-circuit the
      // `if (url && token)` init block in web/lib/rateLimit.ts so every
      // `withRateLimit(...)` wrapper no-ops.
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      // Disable the in-memory rate limiter too — it caps at 15 requests
      // per minute per IP, which is easy to blow through with back-to-back
      // admin-API E2E specs (tokens, installers, webhooks, admin-api-403,
      // etc.) and produces flaky 429s unrelated to the contract under test.
      // Only honored when explicitly set; production ignores this var.
      E2E_DISABLE_RATE_LIMIT: 'true',
      // Tells web/lib/r2Client.server.ts:hasChunk() to consult the
      // Firestore `siteChunks/{digest}` presence rows seeded by
      // web/e2e/helpers/seed.ts:seedChunks instead of doing a real R2
      // HeadObject. Production code path is unchanged when this var is
      // unset. Required for any spec that lets POST /versions go through
      // the real finalize handler.
      OWLETTE_E2E: '1',
    },
  },
});
