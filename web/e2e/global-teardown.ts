/**
 * Playwright global-teardown — runs once after all specs.
 *
 * No-op for now. `firebase emulators:exec` handles emulator shutdown
 * automatically when the `playwright test` command exits. Fixtures are
 * gitignored; we leave them in place after a local run so devs can inspect
 * them if debugging, but CI cleans the workspace between runs anyway.
 *
 * If we later need to export a test-run report, send a notification, or
 * clean up generated artifacts, this is where it goes.
 */

import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  // Intentionally empty.
}
