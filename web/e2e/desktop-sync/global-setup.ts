/**
 * Bring up the whole desktop↔web loop before any spec runs.
 *
 * Order is load-bearing:
 *   1. The BASE global-setup — emulators reachable, state reset, users + sites
 *      seeded, storageState captured per role. Reused wholesale rather than
 *      reimplemented; the web half of this suite needs exactly the fixtures the
 *      main suite already builds.
 *   2. Sandbox built and PROVED, before anything is spawned.
 *   3. Agent credential minted (after the reset — it wipes Auth) and encrypted
 *      into the sandbox token store.
 *   4. Agent started, and awaited until it says it is connected.
 *
 * The emulators and the :3100 web server are NOT started here: `firebase
 * emulators:exec` wraps the run (see `npm run e2e:desktop-sync`) and Playwright's
 * `webServer` brings the app up before global setup, exactly as for `npm run e2e`.
 */

import type { FullConfig } from '@playwright/test'
import baseGlobalSetup from '../global-setup'
import { getAdminDb } from '../helpers/emulator'
import { TEST_USERS } from '../helpers/seed'
import { pinDashboardContext } from '../helpers/processConfig'
import { mintAgentToken, writeTokenStore } from './agentToken'
import { startAgent, waitForConnected } from './agentProcess'
import {
  OUTPUT_DIR,
  SITE_ID,
  createSandbox,
  dataRootOf,
  probeAgentEnv,
  seedSandbox,
  writeSession,
} from './sandbox'

export default async function globalSetup(config: FullConfig): Promise<void> {
  console.log('[desktop-sync] running the base e2e global setup (emulators, seed, storageState)...')
  // The storageState capture's sign-in occasionally times out on a cold
  // `next start` under load (the staged 2FA form reveals the password field
  // late). One retry against the now-warm server settles it; a second failure
  // is a real problem and propagates.
  try {
    await baseGlobalSetup(config)
  } catch (error) {
    console.log(`[desktop-sync] base setup failed once (${String(error).split('\n')[0]}) — retrying against the warm server...`)
    await baseGlobalSetup(config)
  }

  // The dashboard has to open on site-A with process rows expanded, or the
  // web-side oracles assert against a collapsed card.
  await pinDashboardContext(TEST_USERS.admin.uid, SITE_ID)
  await pinDashboardContext(TEST_USERS.superadmin.uid, SITE_ID)

  console.log('[desktop-sync] building the sandbox...')
  const programData = createSandbox()
  const dataRoot = dataRootOf(programData)

  // Before any agent process exists: make the agent's own path code tell us
  // where it would write, and abort if that is not the sandbox.
  const probe = probeAgentEnv(programData)
  seedSandbox(programData, SITE_ID)

  // Not `os.hostname()`: the machine id has to be whatever
  // `shared_utils.get_hostname()` returns, because that is what the agent puts
  // in the document path AND what the token claim has to match.
  const machineId = probe.hostname
  console.log(`[desktop-sync] agent data root: ${probe.dataRoot}`)
  console.log(`[desktop-sync] agent machine id: ${machineId}`)

  console.log('[desktop-sync] minting the agent credential...')
  const credential = await mintAgentToken(SITE_ID, machineId)
  const tokenFile = writeTokenStore(programData, SITE_ID, credential)
  console.log(`[desktop-sync] token store written: ${tokenFile}`)

  console.log('[desktop-sync] starting the agent...')
  const startedAt = Date.now()
  const agent = startAgent(programData, OUTPUT_DIR)
  console.log(`[desktop-sync] agent pid ${agent.pid}, console log ${agent.logPath}`)

  writeSession({
    programData,
    dataRoot,
    siteId: SITE_ID,
    machineId,
    agentPid: agent.pid,
    agentLog: agent.logPath,
    startedAt,
  })

  const { status, elapsedMs } = await waitForConnected(dataRoot)
  console.log(
    `[desktop-sync] agent connected in ${(elapsedMs / 1000).toFixed(1)}s ` +
      `(site=${status.firebase?.site_id}, health=${status.health?.status})`,
  )

  // The agent seeds `config/{siteId}/machines/{machineId}` from its local
  // config.json on connect (`decide_startup_sync` → 'seed'). Wait for it here so
  // no spec has to reason about a document that does not exist yet.
  const configRef = getAdminDb()
    .collection('config')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)

  const seedDeadline = Date.now() + 30_000
  while (Date.now() < seedDeadline) {
    if ((await configRef.get()).exists) {
      console.log(`[desktop-sync] config doc seeded: config/${SITE_ID}/machines/${machineId}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `agent connected but never seeded config/${SITE_ID}/machines/${machineId} — ` +
      'a rules denial on the config doc looks exactly like this. Check the agent log.',
  )
}
