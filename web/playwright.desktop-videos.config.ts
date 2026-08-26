import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop-app tutorial VIDEO capture
 * (`npm run videos:desktop`).
 *
 * Sibling of `playwright.desktop-screenshots.config.ts` — same subject (the
 * INSTALLED `owlette-desktop.exe`, driven over its WebView2 debug port), same
 * absence of a web app: no webServer, no emulators, no seeded users, and no
 * browser launched. The specs `connectOverCDP` and never touch the `page` /
 * `browser` fixtures.
 *
 * Differences from the stills config: `testMatch` on `*.video.ts`, a much larger
 * `timeout` because scenes deliberately dwell for the length of a narration MP3,
 * and a `globalTimeout` sized for several takes back to back.
 *
 * `workers: 1` and serial specs are structural, not tuning — there is one window
 * on the machine, each take launches its own instance of it, and each scenario
 * overwrites the previous one's seam files underneath. `retries: 0` because a
 * take that only works on the second attempt is not footage anyone should cut.
 *
 * MP4s go to `e2e/.output/desktop-videos/`; `outputDir` is only for failure
 * artifacts. Needs a real installed agent and an interactive desktop session, so
 * this is a capture-session step, never CI — see `e2e/desktop-videos/README.md`.
 */

const OUTPUT_DIR =
  process.env.E2E_DESKTOP_VIDEOS_OUTPUT_DIR || './e2e/.output/desktop-videos-results';

export default defineConfig({
  testDir: './e2e/desktop-videos',
  testMatch: /\.video\.ts$/,
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/desktop-videos/global-setup'),
  globalTeardown: require.resolve('./e2e/desktop-videos/global-teardown'),

  // Each take launches and frames the app (up to ~30s) and then dwells for the
  // beats it carries; episode 9's main take alone is over two minutes.
  globalTimeout: 30 * 60_000,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },

  use: {
    trace: 'retain-on-failure',
    // Off: a failure screenshot has nothing to say about a video take, and
    // Playwright's own video cannot record a connectOverCDP context anyway —
    // ffmpeg is the capture path (see e2e/videos/ffmpeg-recorder.ts).
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
  },
});
