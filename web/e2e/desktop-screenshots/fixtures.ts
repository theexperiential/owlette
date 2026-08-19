/**
 * The canonical machine the agent documentation shows.
 *
 * Every value here is fixture data written into the scratch owlette tree from
 * `harness.ts` — nothing is read from, or written to, the machine running the
 * capture. The three documents are the seam the desktop app renders:
 * `config/config.json` (what this machine is supposed to run),
 * `tmp/app_states.json` (what the service has actually launched) and
 * `tmp/service_status.json` (whether the service is up and talking to owlette).
 *
 * The processes are the three shapes owlette exists for: a TouchDesigner show
 * that must never be down, a kiosk that runs to opening hours, and a headless
 * node media server. Between them they cover all three launch modes, both
 * visibilities, a schedule with two blocks, and a running / idle mix of status
 * dots.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeSeamFile, writeTextFile } from './harness'

/** Stable ids, so a re-run produces the same document byte for byte. */
const SHOW_ID = '6f2a8c14-93bd-4f0e-9a71-2c5d8e4b1a30'
const KIOSK_ID = 'b1d47e29-05c6-4a83-8fd2-71e9a3c6b508'
const SERVER_ID = 'd93c1f6a-8e42-4bd7-95c1-0a6f2b74e8d3'

/** Anchored so `app_states.json` never varies between runs. */
const FIXED_EPOCH_SECONDS = 1_776_412_800

/** The site the demo machine belongs to. Matches the `default_site` spelling. */
export const DEMO_SITE_ID = 'main_gallery'

/** Pairing phrase the join dialog shows — the one the docs already use. */
export const DEMO_PAIR_PHRASE = 'silver-compass-drift'

/**
 * `paired` is a working machine. `paired-empty` is the same machine the minute
 * after it was enrolled — joined to a site, nothing configured to run yet.
 * `unpaired` has no `firebase` block at all, which is the state the join dialog
 * exists to leave.
 */
export type Scenario = 'paired' | 'paired-empty' | 'unpaired'

/**
 * The agent version the footer reports.
 *
 * Read from the repo's `VERSION` rather than hardcoded: this pipeline runs as
 * part of a release, and a screenshot claiming the previous version is exactly
 * the kind of staleness it exists to prevent.
 */
export function agentVersion(): string {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), '..', 'VERSION'), 'utf8').trim()
  } catch {
    return '3.0.0'
  }
}

function baseConfig(): Record<string, unknown> {
  return {
    version: '1.6.0',
    environment: 'production',
    processes: [],
    logging: {
      level: 'INFO',
      max_age_days: 90,
      firebase_shipping: { enabled: false, ship_errors_only: true },
    },
    sentry: { enabled: false, dsn: '' },
    displays: { enabled: true, assigned: null, auto_enforce: false, remoteApplyEnabled: false },
    watchdog: {
      enabled: true,
      thresholds: { failure_seconds: 360, boot_grace_seconds: 180 },
      budget: { max_per_window: 3, window_seconds: 3600 },
      preconditions: { require_internet: true, fatal_error_suppression_seconds: 3600 },
    },
  }
}

const DEMO_PROCESSES = [
  {
    id: SHOW_ID,
    processId: SHOW_ID,
    name: 'gallery show',
    exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
    file_path: 'C:\\shows\\gallery-loop.toe',
    cwd: 'C:\\shows',
    priority: 'High',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '30',
    relaunch_attempts: '5',
    launch_mode: 'always',
    autolaunch: true,
    schedules: null,
  },
  {
    id: KIOSK_ID,
    processId: KIOSK_ID,
    name: 'lobby kiosk',
    exe_path: 'C:\\kiosk\\LobbyKiosk.exe',
    file_path: '-screen-fullscreen 1 -screen-width 3840',
    cwd: 'C:\\kiosk',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '15',
    time_to_init: '20',
    relaunch_attempts: '3',
    launch_mode: 'scheduled',
    autolaunch: true,
    // One block, deliberately. The summary beside the segmented control is not
    // truncated and the control keeps its labels on one line at the capture
    // width — a second block pushes both, and a screenshot of a squeezed
    // control teaches the wrong thing about the UI.
    schedules: [
      {
        name: 'opening hours',
        colorIndex: 0,
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        ranges: [{ start: '09:00', stop: '18:00' }],
      },
    ],
  },
  {
    id: SERVER_ID,
    processId: SERVER_ID,
    name: 'media server',
    exe_path: 'C:\\Program Files\\nodejs\\node.exe',
    file_path: 'C:\\media-server\\server.js',
    cwd: 'C:\\media-server',
    priority: 'Normal',
    visibility: 'Hidden',
    time_delay: '5',
    time_to_init: '10',
    relaunch_attempts: '5',
    launch_mode: 'always',
    autolaunch: true,
    schedules: null,
  },
]

/** Process names as the sidebar lists them, in launch order. */
export const DEMO_PROCESS_NAMES = DEMO_PROCESSES.map((process) => process.name)

/**
 * The service's live table.
 *
 * The two always-on entries are running; the kiosk has no row at all, which is
 * what an entry outside its schedule window looks like — an INACTIVE hollow
 * ring rather than a filled dot.
 */
const DEMO_APP_STATES = {
  '4212': { id: SHOW_ID, status: 'RUNNING', timestamp: FIXED_EPOCH_SECONDS },
  '5188': { id: SERVER_ID, status: 'RUNNING', timestamp: FIXED_EPOCH_SECONDS },
}

function serviceStatusFile(scenario: Scenario): Record<string, unknown> {
  const paired = scenario !== 'unpaired'
  return {
    service: { running: true, last_update: FIXED_EPOCH_SECONDS, version: agentVersion() },
    firebase: {
      enabled: paired,
      connected: paired,
      site_id: paired ? DEMO_SITE_ID : '',
      last_heartbeat: FIXED_EPOCH_SECONDS,
    },
    health: {
      status: 'ok',
      error_code: null,
      error_message: null,
      checked_at: FIXED_EPOCH_SECONDS,
      probe_results: {
        config_readable: true,
        firebase_section_present: paired,
        token_store_accessible: paired,
        network_reachable: true,
      },
    },
  }
}

/**
 * The pairing helper the join dialog runs.
 *
 * The real `configure_site.py` asks owlette for a device code and polls until
 * somebody approves it. Documentation does not need a live code — and burning
 * one on every release build would be gratuitous — so the scratch tree carries a
 * stand-in that speaks the same one-JSON-object-per-line protocol
 * (`desktop/src/lib/agentCli.ts`) and then waits to be cancelled, which is what
 * closing the dialog does to the real helper too.
 */
const PAIRING_STUB = `"""Documentation stand-in for configure_site.py --json-progress.

Written into the capture-only scratch tree by web/e2e/desktop-screenshots.
It emits the same events the real helper does, with a fixed phrase, and never
contacts owlette.
"""
import json
import sys
import time

PHRASE = ${JSON.stringify(DEMO_PAIR_PHRASE)}


def emit(event, value):
    sys.stdout.write(json.dumps({"event": event, "value": value}) + "\\n")
    sys.stdout.flush()


emit("status", "requesting a pairing phrase")
emit(
    "phrase",
    {
        "pairPhrase": PHRASE,
        "pairingUrl": "https://owlette.app/add?code=" + PHRASE,
        "verificationUri": "https://owlette.app/add",
        "expiresIn": 600,
    },
)
emit("status", "waiting for approval at owlette.app/add")

# The dialog cancels the run when it closes; until then the real helper is
# polling, so this one waits.
time.sleep(900)
`

/** Everything that does not change between scenarios. */
export function seedStaticFiles(root: string): void {
  writeTextFile(root, 'agent/VERSION', `${agentVersion()}\n`)
  writeTextFile(root, 'agent/src/configure_site.py', PAIRING_STUB)
}

/** Put one scenario's seam files in place. See {@link Scenario}. */
export function seedScenario(root: string, scenario: Scenario): void {
  const config = baseConfig()
  if (scenario === 'paired') config.processes = DEMO_PROCESSES
  if (scenario !== 'unpaired') config.firebase = { enabled: true, site_id: DEMO_SITE_ID }

  writeSeamFile(root, 'config/config.json', config)
  writeSeamFile(root, 'tmp/app_states.json', scenario === 'paired' ? DEMO_APP_STATES : {})
  writeSeamFile(root, 'tmp/service_status.json', serviceStatusFile(scenario))
}
