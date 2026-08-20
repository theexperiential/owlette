/**
 * Start and stop the agent-under-test.
 *
 * The agent is a plain console process — `python owlette_runner.py`, cwd
 * `agent/src`. That is not a simplification of production: `owlette-host`
 * (agent/host, the Rust service host) launches exactly this command line, so a
 * console run exercises the same code with the same entry point. Nothing here
 * needs the SCM or elevation.
 *
 * Stopping is the part worth getting right. `owlette-host` signals a stop by
 * dropping `tmp/stop_signal.json`, and `OwletteService._read_stop_sentinel`
 * (agent/src/owlette_service.py:949) honours it only when `written_at_ms` is
 * NEWER than the process's own start — freshness, not deletion, is the guard
 * that stops a stale survivor from killing every future boot. So the sentinel is
 * written while the agent is running, never pre-created, and a kill by pid is
 * only the fallback.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_SRC, PYTHON, agentEnv, dataRootOf } from './sandbox'

export interface ServiceStatus {
  service?: { running?: boolean; version?: string; last_update?: number }
  firebase?: {
    enabled?: boolean
    connected?: boolean
    site_id?: string
    site_name?: string
    last_heartbeat?: number
  }
  health?: { status?: string; error_code?: string | null; error_message?: string | null }
}

export function serviceStatusPath(dataRoot: string): string {
  return path.join(dataRoot, 'tmp', 'service_status.json')
}

/** Current `tmp/service_status.json`, or null while it is absent or mid-rename. */
export function readServiceStatus(dataRoot: string): ServiceStatus | null {
  try {
    return JSON.parse(fs.readFileSync(serviceStatusPath(dataRoot), 'utf8')) as ServiceStatus
  } catch {
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 probes without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface StartedAgent {
  pid: number
  logPath: string
}

/**
 * Launch the agent against the sandbox and return once it is running.
 *
 * stdout/stderr go to a file rather than being inherited: the agent logs to
 * `<sandbox>/Owlette/logs/service.log` anyway, but an import-time crash never
 * reaches that file, and a silent exit is the failure mode worth being able to
 * read afterwards.
 */
export function startAgent(programData: string, outputDir: string): StartedAgent {
  const logPath = path.join(outputDir, 'agent-console.log')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(logPath, '')
  const out = fs.openSync(logPath, 'a')

  const child = spawn(PYTHON, ['owlette_runner.py'], {
    cwd: AGENT_SRC,
    env: agentEnv(programData),
    stdio: ['ignore', out, out],
    windowsHide: true,
  })

  if (child.pid === undefined) {
    throw new Error('could not start owlette_runner.py')
  }
  return { pid: child.pid, logPath }
}

/**
 * Wait for the agent to report a live Firestore connection.
 *
 * `firebase.connected` mirrors `FirebaseClient.is_connected()` through
 * `_write_service_status` (agent/src/owlette_service.py:571), so this is the
 * agent's own verdict, not an inference from the emulator side.
 *
 * Budget the full 180s, and expect to use ~100 of it. The agent opens with a
 * network gate that TCP-probes `api_base`'s host on a HARDCODED PORT 443
 * (`health_probe.py:38` / `:327`) — correct for the https api_base every real
 * agent has, and unreachable for the loopback `http://127.0.0.1:3100` this suite
 * uses, so the gate always spends its whole 90s budget
 * (`NETWORK_GATE_MAX_WAIT`) before proceeding. It is non-fatal by design and the
 * connection succeeds straight after; a measured run connected in 89.2s, which
 * is why 90s is not the ceiling here.
 */
export async function waitForConnected(
  dataRoot: string,
  timeoutMs = 180_000,
): Promise<{ status: ServiceStatus; elapsedMs: number }> {
  const started = Date.now()
  let last: ServiceStatus | null = null

  while (Date.now() - started < timeoutMs) {
    last = readServiceStatus(dataRoot)
    if (last?.firebase?.connected === true) {
      return { status: last, elapsedMs: Date.now() - started }
    }
    await delay(250)
  }

  throw new Error(
    `agent did not report firebase.connected within ${timeoutMs}ms.\n` +
      `  last service_status.json: ${JSON.stringify(last, null, 2)}\n` +
      `  agent log: ${path.join(dataRoot, 'logs', 'service.log')}`,
  )
}

/**
 * Ask the agent to stop the way its supervisor does, then make sure it did.
 *
 * Written only now — a sentinel that predates the process start is ignored as
 * stale by design, so pre-creating one would stop nothing.
 */
export async function stopAgent(
  programData: string,
  pid: number,
  graceMs = 25_000,
): Promise<'sentinel' | 'killed' | 'already-gone'> {
  if (!isAlive(pid)) return 'already-gone'

  const dataRoot = dataRootOf(programData)
  const sentinel = path.join(dataRoot, 'tmp', 'stop_signal.json')
  try {
    fs.mkdirSync(path.dirname(sentinel), { recursive: true })
    fs.writeFileSync(
      sentinel,
      JSON.stringify({ control: 'stop', written_at_ms: Date.now() }),
    )
  } catch {
    // Fall through to the kill — a sandbox we cannot write to is already broken.
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return 'sentinel'
    await delay(250)
  }

  // By pid, with /T for the python child tree — never by image name, which
  // would take out the operator's unrelated python processes.
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    // Raced us to exit.
  }
  return 'killed'
}
