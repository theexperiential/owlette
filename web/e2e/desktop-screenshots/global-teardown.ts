/**
 * Give the machine back.
 *
 * The capture instance is stopped first and waited for, because it writes the
 * window layout on its way out — restoring the operator's file before that would
 * be overwritten by the process we just killed. The service re-spawns a tray
 * within its 30-second cooldown once ours is gone; nothing here has to do it.
 */

import {
  clearSession,
  killScratchHelpers,
  readSession,
  releaseTrayPid,
  removeScratchRoot,
  restoreLayout,
  stopDesktop,
} from './harness'

async function globalTeardown(): Promise<void> {
  try {
    await stopDesktop(readSession())
  } catch {
    // No session file, or the instance was already gone — either way there is
    // nothing left to stop, and the restore below still has to happen.
  }

  killScratchHelpers()
  clearSession()
  restoreLayout()
  releaseTrayPid()
  removeScratchRoot()
}

export default globalTeardown
