import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the tutorial VIDEO-capture pipeline.
 *
 * Sibling of `playwright.screenshots.config.ts` — same emulator boot, global-setup,
 * webServer block, and seeded demo fleet (so machine names / metrics read like a real
 * operation). The differences:
 *   - testDir is `./e2e/videos`, matching only `*.video.ts` files
 *   - 1920×1080 viewport so footage drops straight into a 1080p timeline
 *   - serial, retries:0 (deterministic capture, loud failures)
 *
 * Each scene file creates its OWN browser context with `recordVideo` (via
 * `recordScene()` in `e2e/videos/video-helpers.ts`) so it can name the output file
 * after the episode/scene. The clean .webm files land in `e2e/.output/videos/`.
 *
 * Triggered explicitly by `npm run videos`; never in CI.
 */

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const NEXT_DIST_DIR = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';
const OUTPUT_DIR = process.env.E2E_VIDEOS_OUTPUT_DIR || './e2e/.output/videos-results';

export default defineConfig({
  testDir: './e2e/videos',
  testMatch: /\.video\.ts$/,
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  // Generous timeout — scenes deliberately dwell (narration gaps) and can run minutes.
  timeout: 5 * 60_000,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),

  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'off',
    // Scenes record via an external ffmpeg subprocess (see e2e/videos/ffmpeg-recorder.ts);
    // Playwright's built-in video is off so we don't get a parallel downscaled VP8.
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    // viewport: null — chromium honors the explicit --window-size launch arg below.
    viewport: null,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        // Explicit viewport: Playwright resizes the chrome window so the page's
        // inner content area is EXACTLY 1920×1080 — irrespective of how tall the
        // chrome UI (tabs + address bar) ends up. recordScene then measures the
        // chrome UI offset at runtime and feeds it to ffmpeg's ddagrab capture
        // region, so the captured frame contains the page content only — no
        // address bar, no tab strip. (We can't reliably go chromeless via flags:
        // --kiosk lands in an exclusive-presentation path that DXGI can't capture,
        // --start-fullscreen gets overridden by --window-size, and --app= doesn't
        // compose with Playwright's newContext().newPage() window-spawning model.)
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        launchOptions: {
          headless: false,
          // Drop the `--enable-automation` default arg so Chromium doesn't paint
          // the yellow "Chrome is being controlled by automation" banner across
          // the top of every frame.
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            // Leave room for the chrome UI on top of the 1080p content; Playwright
            // will resize to make inner === 1920×1080, but the outer window won't
            // exceed this initial allowance, so we know the chrome UI stays
            // within the first ~120 vertical pixels.
            '--window-position=0,0',
            '--window-size=1920,1200',
            '--force-device-scale-factor=1',
            '--force-color-profile=srgb',
            '--disable-blink-features=AutomationControlled',
            // Quiet things that would otherwise paint over the page mid-capture:
            '--disable-notifications',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
          ],
        },
      },
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
