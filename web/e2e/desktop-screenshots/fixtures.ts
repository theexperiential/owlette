/**
 * The canonical machine the agent documentation shows. All fixture data, written
 * into a scratch owlette tree by `harness.ts` — nothing touches the capture
 * machine. The three seam documents the desktop app renders are
 * `config/config.json`, `tmp/app_states.json` and `tmp/service_status.json`.
 *
 * The three processes (TD show, scheduled kiosk, headless media server) cover
 * all launch modes, both visibilities, a two-block schedule and a running/idle
 * mix of status dots.
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
 * Agent version in the footer. Read from the repo's `VERSION`, not hardcoded —
 * this runs as part of a release and must not screenshot a stale version.
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
    // One block, deliberately: a second wraps the segmented control's labels
    // and truncates the summary at the capture width.
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
 * The service's live table. The two always-on entries run; the kiosk has NO row,
 * which is how an entry outside its schedule window looks (hollow INACTIVE ring).
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
 * Stand-in for the pairing helper the join dialog runs. Avoids burning a real
 * device code per release build: speaks the same one-JSON-object-per-line
 * protocol (`desktop/src/lib/agentCli.ts`), then waits to be cancelled.
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
