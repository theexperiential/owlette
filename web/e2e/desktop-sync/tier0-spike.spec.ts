/**
 * Tier 0 — the headless proof that the loop closes.
 *
 * No desktop app. This spec stands in for it by writing `config.json` the same
 * way the app does (scratch file, then rename), which is all the agent can
 * observe: it watches the file's mtime, not its author. If this tier is red, the
 * desktop tiers cannot be anything but red, and this one says WHICH link broke.
 *
 * Every write in the agent→cloud direction goes through the REAL security rules
 * with the agent's claimed token — the emulator evaluates `firestore.rules`
 * exactly as production does. Only the ORACLES use the Admin SDK.
 *
 * Serial: both directions drive the same document, and the run's evidence file
 * is written at the end.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readServiceStatus } from './agentProcess'
import {
  BUDGET,
  agentLogTail,
  expect,
  makeProcess,
  readLocalProcesses,
  readWireProcesses,
  test,
  writeWireConfig,
} from './fixtures'
import { OUTPUT_DIR, readLocalConfig, writeLocalConfig } from './sandbox'

test.describe.configure({ mode: 'serial' })

const evidence: Record<string, unknown> = {}

test.afterAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'tier0-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  console.log(`[tier0] evidence:\n${JSON.stringify(evidence, null, 2)}`)
})

test('(a) the sandboxed agent reports a live Firestore connection', async ({ sync }) => {
  const status = readServiceStatus(sync.dataRoot)

  expect(status, 'tmp/service_status.json should exist').not.toBeNull()
  expect(status?.firebase?.connected, agentLogTail(sync.dataRoot)).toBe(true)
  expect(status?.firebase?.enabled).toBe(true)
  expect(status?.firebase?.site_id).toBe(sync.siteId)

  evidence.connection = {
    dataRoot: sync.dataRoot,
    machineId: sync.machineId,
    siteId: sync.siteId,
    agentPid: sync.agentPid,
    serviceStatus: status,
  }
})

test('(b) a local config.json edit reaches the emulator config doc', async ({ sync }) => {
  const before = await readWireProcesses(sync.siteId, sync.machineId)
  expect(
    before.map((p) => p.id),
    'the agent should have seeded an empty process list on connect',
  ).not.toContain('tier0-up');

  const config = readLocalConfig(sync.dataRoot)
  const processes = Array.isArray(config.processes) ? config.processes : []
  config.processes = [
    ...processes,
    makeProcess({ id: 'tier0-up', name: 'tier0 upstream', time_to_init: '25' }),
  ]

  const startedAt = Date.now()
  writeLocalConfig(sync.dataRoot, config)

  await expect
    .poll(
      async () => (await readWireProcesses(sync.siteId, sync.machineId)).map((p) => p.id),
      {
        message: `local edit never reached the config doc.\n${agentLogTail(sync.dataRoot)}`,
        timeout: BUDGET.desktopToWireMs,
        intervals: [200],
      },
    )
    .toContain('tier0-up')

  const elapsedMs = Date.now() - startedAt
  const landed = (await readWireProcesses(sync.siteId, sync.machineId)).find(
    (p) => p.id === 'tier0-up',
  )

  // Not just the id: a push that dropped fields would still contain the id.
  expect(landed?.name).toBe('tier0 upstream')
  expect(landed?.time_to_init).toBe('25')

  evidence.desktopToWire = { elapsedMs, budgetMs: BUDGET.desktopToWireMs, landed }
  console.log(`[tier0] local → wire: ${elapsedMs}ms (budget ${BUDGET.desktopToWireMs}ms)`)
})

test('(c) an emulator-side config edit reaches the sandbox config.json', async ({ sync }) => {
  const wire = await readWireProcesses(sync.siteId, sync.machineId)
  const patched = wire.map((process) =>
    process.id === 'tier0-up'
      ? { ...process, name: 'tier0 renamed by cloud', time_to_init: '45' }
      : process,
  )
  expect(patched.some((p) => p.id === 'tier0-up'), 'test (b) must run first').toBe(true)

  const startedAt = Date.now()
  await writeWireConfig(sync.siteId, sync.machineId, { processes: patched })

  await expect
    .poll(
      () => readLocalProcesses(sync.dataRoot).find((p) => p.id === 'tier0-up')?.name,
      {
        message: `cloud edit never reached config.json.\n${agentLogTail(sync.dataRoot)}`,
        timeout: BUDGET.wireToLocalMs,
        intervals: [250],
      },
    )
    .toBe('tier0 renamed by cloud')

  const elapsedMs = Date.now() - startedAt
  const applied = readLocalProcesses(sync.dataRoot).find((p) => p.id === 'tier0-up')
  expect(applied?.time_to_init).toBe('45')

  // The pull must not have taken the local-only keys with it — losing the
  // `firebase` block would unpair the agent, and `config_sync.LOCAL_ONLY_KEYS`
  // exists to stop exactly that.
  const local = readLocalConfig(sync.dataRoot)
  expect((local.firebase as Record<string, unknown> | undefined)?.site_id).toBe(sync.siteId)

  evidence.wireToLocal = { elapsedMs, budgetMs: BUDGET.wireToLocalMs, applied }
  console.log(`[tier0] wire → local: ${elapsedMs}ms (budget ${BUDGET.wireToLocalMs}ms)`)
})
