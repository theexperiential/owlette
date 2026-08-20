/**
 * Playwright global-teardown. No-op: `firebase emulators:exec` shuts the
 * emulators down when `playwright test` exits, and the gitignored fixtures are
 * left in place for local debugging (CI cleans the workspace anyway).
 */

import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  // Intentionally empty.
}
