/**
 * Fixtures and oracles for the desktop↔web sync suite.
 *
 * Three oracles, and which one a spec may use is decided by the code, not by
 * preference:
 *
 * - THE WIRE (`config/{siteId}/machines/{machineId}`) — the document the agent
 *   consumes and every web mutation writes. The only oracle that proves a sync
 *   happened.
 * - THE LOCAL FILE (`<sandbox>/Owlette/config/config.json`) — what the desktop
 *   app renders and the agent applies.
 * - THE DASHBOARD — and here the split matters: `useFirestore`'s config listener
 *   overlays only `launch_mode` / `schedules` / `schedulePresetId` live from the
 *   config doc. Names, paths and timing fields are rendered from the STATUS doc
 *   (`sites/{siteId}/machines/{machineId}.metrics.processes`), which only the
 *   AGENT writes, on its metrics cadence. See `e2e/helpers/processConfig.ts`.
 *   A spec that asserts a renamed process in the UI is asserting the agent's
 *   metrics upload, not the config sync — and needs the slower budget to match.
 */

import { test as base, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import { getAdminDb } from '../helpers/emulator'
import { connectDesktopPage, desktopExeConfigured, startDesktopOnSandbox } from './desktopSession'
import { readLocalConfig, readSession, type SyncSession } from './sandbox'

export { expect } from '@playwright/test'

/**
 * Timing budgets, each traced to the code that sets it. Never a
 * `waitForTimeout` — these are ceilings for `expect.poll`, not sleeps.
 */
export const BUDGET = {
  /**
   * Local edit → config doc. 0.5s mtime poll
   * (`owlette_service.LOCAL_CONFIG_POLL_INTERVAL`) + one Firestore write, plus
   * headroom for `PushBackoff`'s 5s floor after a transient failure.
   */
  desktopToWireMs: 15_000,
  /**
   * Local edit → STATUS doc. This is a PRODUCT SLO, not an accommodation of the
   * metrics cadence: a successful local config push triggers one immediate
   * metrics upload (`_check_local_config_changes`'s push thread, mirroring
   * `handle_config_update`), so the status doc must follow the config doc
   * within push (~1s) + metrics collection (~2s) + one write. The field bug
   * this guards: before the immediate push, row membership on the dashboard
   * waited out the heartbeat cadence — 20-120s — because the interval is
   * picked AFTER each upload and an idle interval already counting down is not
   * interrupted. A spec that waits for the cadence before measuring can never
   * catch that class; this budget deliberately does not.
   */
  desktopToStatusMs: 6_000,
  /** Status-doc change → dashboard paint. `desktopToStatusMs` plus the web's
   * `onSnapshot` delivery and a React render. */
  desktopToDashboardMs: 10_000,
  /**
   * Config doc → local file. The agent's config listener polls adaptively
   * between 2s and 10s (`firebase_client._config_listener_loop`, backoff 1.3),
   * so a change can wait out a full 10s idle interval before it is seen.
   */
  wireToLocalMs: 30_000,
  /**
   * Config doc → desktop UI. `wireToLocalMs` plus the app's own watcher (120ms
   * in Rust) and React's 80ms debounce, plus paint headroom.
   */
  wireToDesktopMs: 30_000,
} as const

export interface SyncFixtures {
  /** The run's sandbox, agent pid, site and machine id. */
  sync: SyncSession
  /** The desktop app's webview. Requires OWLETTE_DESKTOP_EXE. */
  desktopPage: Page
}

/**
 * The second fixture argument is Playwright's `use`, renamed to `provide` here.
 * It is positional, so the name is free — and `use` trips
 * `react-hooks/rules-of-hooks`, which cannot tell a Playwright fixture from the
 * React hook of the same name. Renaming beats disabling a correctness rule.
 */
export const test = base.extend<SyncFixtures>({
  sync: async ({}, provide) => {
    await provide(readSession())
  },

  // Worker-scoped would be nicer, but the app is single-instance and the
  // teardown has to be able to run even when a spec fails mid-way; one launch
  // per spec file, with the suite running workers:1, is the honest shape.
  desktopPage: async ({ sync }, provide) => {
    let browser: Browser | undefined
    const session = await startDesktopOnSandbox(sync.programData)
    try {
      const attached = await connectDesktopPage(session.port)
      browser = attached.browser
      await provide(attached.page)
    } finally {
      // Detaches the CDP client only; global teardown stops the process.
      await browser?.close()
    }
  },
})

/** Skip a spec, with the reason spelled out, when no desktop binary was named. */
export function requireDesktopExe(): void {
  test.skip(
    !desktopExeConfigured(),
    'OWLETTE_DESKTOP_EXE is not set — no desktop binary to drive. ' +
      'Build one (cd desktop && npx tauri build --no-bundle) and point the variable at it; ' +
      'see e2e/desktop-sync/README.md.',
  )
}

// Oracles

export interface WireProcess {
  id: string
  name: string
  exe_path: string
  file_path: string
  cwd: string
  priority: string
  visibility: string
  time_delay: string
  time_to_init: string
  relaunch_attempts: string
  autolaunch: boolean
  launch_mode: string
  schedules?: unknown
  [key: string]: unknown
}

/** The config doc the agent consumes — the wire. */
export async function readWireConfig(
  siteId: string,
  machineId: string,
): Promise<Record<string, unknown>> {
  const snap = await getAdminDb()
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get()
  return (snap.data() ?? {}) as Record<string, unknown>
}

export async function readWireProcesses(
  siteId: string,
  machineId: string,
): Promise<WireProcess[]> {
  const processes = (await readWireConfig(siteId, machineId)).processes
  return Array.isArray(processes) ? (processes as WireProcess[]) : []
}

/** Merge a patch into the config doc the way the web API does (admin SDK). */
export async function writeWireConfig(
  siteId: string,
  machineId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await getAdminDb()
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(patch, { merge: true })
}

/** One `metrics.processes[id]` entry — the status doc the dashboard renders from. */
export async function readStatusProcess(
  siteId: string,
  machineId: string,
  processId: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get()
  return snap.data()?.metrics?.processes?.[processId] as Record<string, unknown> | undefined
}

/** The processes array in the sandbox's config.json — what the desktop renders. */
export function readLocalProcesses(dataRoot: string): WireProcess[] {
  const processes = readLocalConfig(dataRoot).processes
  return Array.isArray(processes) ? (processes as WireProcess[]) : []
}

/** A process row shaped the way the agent writes one. */
export function makeProcess(overrides: Partial<WireProcess> & { id: string; name: string }): WireProcess {
  return {
    exe_path: 'C:\\e2e\\sync-fixture.exe',
    file_path: '',
    cwd: 'C:\\e2e',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    autolaunch: false,
    launch_mode: 'off',
    schedules: null,
    ...overrides,
  }
}

/**
 * `metrics.timestamp` in epoch ms — the server timestamp the agent rewrites on
 * every metrics upload (`firebase_client._upload_metrics`, :1465). The cadence
 * signal; 0 until the first upload lands.
 */
export async function readMetricsTimestampMs(
  siteId: string,
  machineId: string,
): Promise<number> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get()
  // The agent's REST client backtick-escapes any transform key containing a dot
  // (`firestore_rest_client._extract_server_timestamps`), so the heartbeat
  // lands as a LITERAL top-level field named "metrics.timestamp" — in
  // production too, not just the emulator. Read both spellings so this keeps
  // working when the client-side quirk is fixed.
  const data = snap.data() as Record<string, unknown> | undefined
  const stamp = (data?.['metrics.timestamp'] ??
    (data?.metrics as Record<string, unknown> | undefined)?.timestamp) as
    | { toMillis?: () => number }
    | undefined
  return typeof stamp?.toMillis === 'function' ? stamp.toMillis() : 0
}

/** The status doc's process-id set, for row-membership assertions. */
export async function readStatusProcessIds(siteId: string, machineId: string): Promise<string[]> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get()
  const processes = (snap.data()?.metrics as Record<string, unknown> | undefined)?.processes
  return processes && typeof processes === 'object' ? Object.keys(processes) : []
}

/** Tail of the agent's own log — the first place to look when a link breaks. */
export function agentLogTail(dataRoot: string, lines = 40): string {
  try {
    const text = fs.readFileSync(`${dataRoot}\\logs\\service.log`, 'utf8')
    return text.split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(no agent log)'
  }
}
