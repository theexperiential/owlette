/**
 * Minimal Playwright config for rendering title cards. The cards are
 * self-contained pages (page.setContent, brand assets inlined) — no app
 * server, no emulators, no global setup. Kept separate from
 * playwright.videos.config.ts so a card batch never boots that stack.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'title-cards.video.ts',
  timeout: 30 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: false,
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      args: ['--window-position=0,0', '--hide-scrollbars'],
    },
  },
});
