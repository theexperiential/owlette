/**
 * Role helpers — `test.use(roleState('admin'))`. global-setup generates each
 * storageState by a real login against the emulator-mode dev server; Playwright
 * restores cookies + localStorage + IndexedDB on new contexts.
 */

import { join } from 'path';
import type { TestRole } from './seed';

const FIXTURES_DIR = process.env.E2E_FIXTURES_DIR || join(__dirname, '..', 'fixtures');

/** Full path to the role's storageState fixture, for `test.use({ storageState })`. */
export function roleState(role: TestRole): { storageState: string } {
  return { storageState: join(FIXTURES_DIR, `${role}.json`) };
}
