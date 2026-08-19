import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the agent documentation's desktop-app screenshots.
 *
 * A third sibling to `playwright.config.ts` (regression e2e) and
 * `playwright.screenshots.config.ts` (marketing/landing captures), and the only
 * one of the three that does not run the web app at all:
 *   - testDir is `./e2e/desktop-screenshots`
 *   - no `webServer`, no Firebase emulators, no seeded users. The subject is the
 *     installed `owlette-desktop.exe` on this machine, driven over CDP; there is
 *     nothing for Next.js or Firestore to serve.
 *   - no browser is launched by Playwright. The specs connect to the running
 *     WebView2's debug port with `chromium.connectOverCDP` and never touch the
 *     `page` / `browser` fixtures, so no `projects` entry declares one.
 *   - workers: 1 and serial specs — there is exactly one window, and each
 *     scenario replaces the previous one's fixture files underneath it.
 *   - retries: 0 — a screenshot that only comes out right on the second attempt
 *     is a screenshot nobody can reproduce.
 *
 * The specs write PNGs straight into `web/public/docs-screens/`, which
 * `web/content/docs/agent/*.mdx` references. `outputDir` below is only for
 * Playwright's own failure artifacts.
 *
 * Requires an installed, working agent on the machine running it (the release
 * binary at `C:\ProgramData\Owlette\app\owlette-desktop.exe`), which is why this
 * is a release-time step rather than part of CI — see
 * `.claude/skills/build-system.md` → "Agent Installer Release".
 *
 * Run with `npm run screenshots:desktop`.
 */

const OUTPUT_DIR =
  process.env.E2E_DESKTOP_SCREENSHOTS_OUTPUT_DIR || './e2e/.output/desktop-screenshots-results';

export default defineConfig({
  testDir: './e2e/desktop-screenshots',
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],

  globalSetup: require.resolve('./e2e/desktop-screenshots/global-setup'),
  globalTeardown: require.resolve('./e2e/desktop-screenshots/global-teardown'),

  // Launching the app, killing the tray it replaced and waiting for its debug
  // port to answer is the slow part, and it happens once in the global setup.
  globalTimeout: 10 * 60_000,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    trace: 'retain-on-failure',
    // The specs screenshot deliberately, into `public/docs-screens/`. A
    // failure screenshot would land in the same run and confuse the output.
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
  },
});
