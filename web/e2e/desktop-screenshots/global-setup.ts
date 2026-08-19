/**
 * Put the machine into the state the capture spec expects, and leave a session
 * file behind so the teardown can put it back even if the run dies mid-test.
 *
 * Order is load-bearing: the layout file has to be pinned *before* the app is
 * launched (the host reads it once, in `setup`), and the scratch tree has to
 * exist before that so the first paint is already showing fixture data rather
 * than an empty document.
 */

import {
  CDP_PORT,
  buildScratchRoot,
  snapshotLayout,
  startDesktop,
  writeSession,
} from './harness'
import { seedScenario, seedStaticFiles } from './fixtures'

async function globalSetup(): Promise<void> {
  snapshotLayout()

  const root = buildScratchRoot()
  seedStaticFiles(root)
  seedScenario(root, 'paired')

  const session = await startDesktop(root, CDP_PORT)
  writeSession(session)
}

export default globalSetup
