/**
 * Give the machine back.
 *
 * A scene that finished cleanly has already stopped its instance and cleared the
 * session file, so the `stopDesktop` here is the crash path — a take that threw
 * mid-scene leaves an app running against the scratch tree, and the restores
 * below must not run while it can still rewrite the layout file on its way out.
 *
 * The service re-spawns a tray within its 30-second cooldown once ours is gone;
 * nothing here has to do it.
 */

import {
  clearSession,
  killScratchHelpers,
  readSession,
  releaseTrayPid,
  removeScratchRoot,
  restoreLayout,
  stopDesktop,
} from '../desktop-screenshots/harness';

async function globalTeardown(): Promise<void> {
  try {
    await stopDesktop(readSession());
  } catch {
    // No session file, or the instance was already stopped by `endTake` —
    // either way there is nothing left to stop, and the restores still have to
    // happen.
  }

  killScratchHelpers();
  clearSession();
  restoreLayout();
  releaseTrayPid();
  removeScratchRoot();
}

export default globalTeardown;
