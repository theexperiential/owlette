/**
 * The demo machine the tutorial films. Written into a scratch
 * `%PROGRAMDATA%\Owlette` by `../desktop-screenshots/harness`, so nothing here
 * touches the capture machine's real config or the running service.
 *
 * A superset of the stills fixture (`../desktop-screenshots/fixtures.ts`), not a
 * replacement — the shared machinery (`writeSeamFile`, `agentVersion`, the
 * pairing phrase, the site id) is imported from it. The extra rows exist because
 * episode 9 asks for states the stills never needed:
 *
 * - TWO entries with `launch_mode: off`. b06 opens the schedule editor from an
 *   off entry to show it is not gated, and flips that entry to `scheduled` —
 *   which would spend the only off row before b07 needs one to contrast the two
 *   restart-confirm wordings.
 * - a `hidden` visibility entry, so b05's advanced disclosure has something to
 *   say.
 *
 * DETERMINISM. The app's clock cannot be frozen from here: `window.Date` would
 * have to be replaced in a page we merely attached to, and the components that
 * render relative time only re-read it when their state changes. So the launch
 * timestamps are pinned as an OFFSET rather than an instant — every run renders
 * "started 3 hours ago", which is the determinism that matters on camera. The
 * status file keeps a fixed epoch: nothing reads its fields as a duration (the
 * two-minute staleness rule is computed from the file's mtime, in the host).
 */

import { agentVersion, DEMO_PAIR_PHRASE, DEMO_SITE_ID } from '../desktop-screenshots/fixtures';
import { writeSeamFile, writeTextFile } from '../desktop-screenshots/harness';

export { DEMO_PAIR_PHRASE, DEMO_SITE_ID };

/** Stable ids, so a re-run produces the same document byte for byte. */
const SHOW_ID = '6f2a8c14-93bd-4f0e-9a71-2c5d8e4b1a30';
const KIOSK_ID = 'b1d47e29-05c6-4a83-8fd2-71e9a3c6b508';
const SERVER_ID = 'd93c1f6a-8e42-4bd7-95c1-0a6f2b74e8d3';
const SIGNAGE_ID = '4a70b3d8-6c19-47e5-bb02-8f31d5e9c274';
const PROJECTOR_ID = '2e58f9a1-71c4-4d36-9807-63bac1f4d5e2';

/** Anchored so `service_status.json` never varies between runs. */
const FIXED_EPOCH_SECONDS = 1_776_412_800;

/** How long the running entries have been up, on camera. See the header note. */
const LAUNCHED_SECONDS_AGO = 3 * 60 * 60;

function launchedAt(): number {
  return Math.floor(Date.now() / 1000) - LAUNCHED_SECONDS_AGO;
}

/**
 * `paired` is the working machine most beats are filmed on. `unpaired` is the
 * SAME machine with its `firebase` block removed, so episode 9's footer cut
 * differs from the shot before it in exactly one line. `fresh` is the minute
 * after an install — belongs to nothing, supervises nothing — which is the
 * machine episode 3's pairing dialog is opened on.
 */
export type VideoScenario = 'paired' | 'unpaired' | 'fresh';

/** Process names as the sidebar lists them, in launch order. */
export const SHOW = 'gallery show';
export const KIOSK = 'lobby kiosk';
export const SERVER = 'media server';
export const SIGNAGE = 'signage player';
export const PROJECTOR = 'projector control';

/** The name `+` gives a new entry (`NEW_PROCESS_DEFAULTS.name`). */
export const NEW_PROCESS_NAME = 'untitled process';

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
  };
}

const DEMO_PROCESSES = [
  {
    id: SHOW_ID,
    processId: SHOW_ID,
    name: SHOW,
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
    name: KIOSK,
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
    // One block, deliberately: a second wraps the segmented control's labels and
    // truncates the summary beside it.
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
    name: SERVER,
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
  {
    // b05's subject: launch mode off, so the recovery group films dimmed, and
    // b06's — the schedule editor opened from off, then switched to scheduled.
    id: SIGNAGE_ID,
    processId: SIGNAGE_ID,
    name: SIGNAGE,
    exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
    file_path: 'C:\\shows\\atrium-signage.toe',
    cwd: 'C:\\shows',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '30',
    relaunch_attempts: '5',
    launch_mode: 'off',
    autolaunch: false,
    schedules: null,
  },
  {
    // b07's second confirm dialog: an off entry the service will NOT bring back.
    id: PROJECTOR_ID,
    processId: PROJECTOR_ID,
    name: PROJECTOR,
    exe_path: 'C:\\tools\\ProjectorControl.exe',
    file_path: '--preset gallery',
    cwd: 'C:\\tools',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    launch_mode: 'off',
    autolaunch: false,
    schedules: null,
  },
];

/** How many rows the sidebar starts a take with. */
export const DEMO_PROCESS_COUNT = DEMO_PROCESSES.length;

/**
 * The service's live table. The two always-on entries run; the kiosk and both
 * off entries have NO row, which is how an entry nothing is running looks
 * (hollow INACTIVE ring).
 */
function appStatesFile(): Record<string, unknown> {
  const started = launchedAt();
  return {
    '4212': { id: SHOW_ID, status: 'RUNNING', timestamp: started },
    '5188': { id: SERVER_ID, status: 'RUNNING', timestamp: started },
  };
}

function serviceStatusFile(scenario: VideoScenario): Record<string, unknown> {
  const paired = scenario === 'paired';
  return {
    service: { running: true, last_update: FIXED_EPOCH_SECONDS, version: agentVersion() },
    firebase: {
      enabled: paired,
      connected: paired,
      site_id: paired ? DEMO_SITE_ID : '',
      site_name: paired ? 'main gallery' : '',
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
  };
}

/**
 * Stand-in for `configure_site.py`, the helper the app spawns for every mode it
 * cannot perform itself (`desktop/src-tauri/src/agent_cli.rs`).
 *
 * A video variant of the stills stub rather than the same file, for two reasons:
 * it has to answer `--report-issue` as well as `--json-progress` (episode 16's
 * beat ends on the success toast, which only fires when the helper exits 0 after
 * a `done` event), and the pairing status line has to read exactly what the
 * script's SCREEN direction says it reads.
 *
 * It never contacts owlette, so a take costs no device code and the phrase on
 * camera is the same one every run.
 */
const AGENT_CLI_STUB = `"""Documentation stand-in for configure_site.py — video variant.

Written into the capture-only scratch tree by web/e2e/desktop-videos. It speaks
the same one-JSON-object-per-line protocol as the real helper
(desktop/src/lib/agentCli.ts), with a fixed pairing phrase, and never contacts
owlette.
"""
import json
import os
import sys
import time

PHRASE = ${JSON.stringify(DEMO_PAIR_PHRASE)}


def emit(event, value):
    sys.stdout.write(json.dumps({"event": event, "value": value}) + "\\n")
    sys.stdout.flush()


def join():
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
    emit("status", "waiting for authorization")

    # The dialog cancels the run when it closes; until then the real helper is
    # polling, so this one waits. Nothing here ever authorizes: an approval on
    # camera would need a real device code.
    time.sleep(900)


def report_issue(payload_path):
    # The real helper reads the staged payload and deletes it (agent_cli.rs
    # stages one file per run); leaving them behind would litter the scratch tmp.
    if payload_path and os.path.isfile(payload_path):
        try:
            with open(payload_path, encoding="utf-8") as handle:
                json.load(handle)
        finally:
            try:
                os.remove(payload_path)
            except OSError:
                pass

    # Roughly what collecting system info and the log tail costs, so the
    # submitting state is on screen long enough to read.
    time.sleep(1.2)
    emit("done", {"reportId": "demo-report"})


def main():
    arguments = sys.argv[1:]
    if "--report-issue" in arguments:
        index = arguments.index("--report-issue")
        staged = arguments[index + 1] if len(arguments) > index + 1 else None
        report_issue(staged)
        return
    if "--leave" in arguments:
        time.sleep(0.8)
        emit("done", {})
        return
    join()


main()
`;

/** Everything that does not change between scenarios. */
export function seedVideoStaticFiles(root: string): void {
  writeTextFile(root, 'agent/VERSION', `${agentVersion()}\n`);
  writeTextFile(root, 'agent/src/configure_site.py', AGENT_CLI_STUB);
}

/** Put one scenario's seam files in place. See {@link VideoScenario}. */
export function seedVideoScenario(root: string, scenario: VideoScenario): void {
  const config = baseConfig();
  if (scenario !== 'fresh') config.processes = DEMO_PROCESSES;
  // No `firebase` block at all unless paired — that is what `isPaired` reads,
  // and what puts `join site` in the footer.
  if (scenario === 'paired') config.firebase = { enabled: true, site_id: DEMO_SITE_ID };

  writeSeamFile(root, 'config/config.json', config);
  writeSeamFile(root, 'tmp/app_states.json', scenario === 'fresh' ? {} : appStatesFile());
  writeSeamFile(root, 'tmp/service_status.json', serviceStatusFile(scenario));
}
