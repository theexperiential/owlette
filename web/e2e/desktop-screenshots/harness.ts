/**
 * Driving the *installed* owlette desktop app (`owlette-desktop.exe`) from
 * Playwright, so the agent documentation can show the UI that actually ships.
 *
 * Three facts shape everything in this file.
 *
 * 1. **The app is a Tauri 2 WebView2 shell.** Setting
 *    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` in the
 *    child's environment turns its webview into an ordinary CDP endpoint, which
 *    `chromium.connectOverCDP` drives like any other page. Nothing is stubbed in
 *    the webview: `window.__TAURI_INTERNALS__` and every function on it are
 *    non-configurable and non-writable, so `invoke` cannot be wrapped from the
 *    page side even with an init script. What the app shows has to come from the
 *    files it reads.
 *
 * 2. **It reads those files from `%PROGRAMDATA%\Owlette`, resolved from the
 *    environment variable** (`src-tauri/src/paths.rs::data_root`). Launching the
 *    capture instance with `PROGRAMDATA` pointed at a scratch tree gives it a
 *    complete, canonical, demo-only view of the world — and means this pipeline
 *    never opens, let alone rewrites, the real `config.json`. The running
 *    service never sees the fixtures either, so no demo process is ever uploaded
 *    to the operator's fleet.
 *
 * 3. **The window's name comes from `COMPUTERNAME`**
 *    (`src-tauri/src/tray.rs::hostname`), which is likewise read from the
 *    environment. The capture instance is launched with a generic one, so the
 *    machine that builds a release never has its hostname published in the docs.
 *
 * The one piece of real machine state this touches is
 * `%APPDATA%\app.owlette.desktop\layout.json` — the per-user window size, which
 * the host reads through the Windows known-folder API rather than an environment
 * variable and therefore cannot be redirected. It is snapshotted, replaced with a
 * canonical size, and restored byte-for-byte after the capture instance exits.
 *
 * Single-instance is the trap to remember: the tray icon *is* the app, so a
 * second launch is folded into the running one instead of starting a process we
 * could attach to. The tray is killed by verified pid first (never by image
 * name), and the service re-spawns one within about 30 seconds of teardown.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Image name the pid checks demand before anything is killed. */
const DESKTOP_IMAGE = 'owlette-desktop.exe'

/** The installed agent's data root — the real one, only ever read from. */
const OWLETTE_ROOT = process.env.OWLETTE_DATA_ROOT || 'C:\\ProgramData\\Owlette'

const DESKTOP_EXE = path.join(OWLETTE_ROOT, 'app', DESKTOP_IMAGE)

/** Marker the desktop app keeps for its whole life; the service reads it too. */
const TRAY_PID_FILE = path.join(OWLETTE_ROOT, 'tmp', 'tray.pid')

/** The bundled interpreter the app spawns for the pairing helper. */
const PYTHON_DIR = path.join(OWLETTE_ROOT, 'python')

/** Per-user window geometry. Not redirectable — snapshotted and restored. */
const LAYOUT_FILE = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'app.owlette.desktop',
  'layout.json',
)

/** Everything this pipeline creates lives here. Git-ignored. */
const SESSION_DIR = path.resolve('e2e/.output/desktop-screenshots')
const SESSION_FILE = path.join(SESSION_DIR, 'session.json')
const LAYOUT_BACKUP = path.join(SESSION_DIR, 'layout.backup.json')
/** Sentinel for "there was no layout file before this run". */
const LAYOUT_ABSENT = path.join(SESSION_DIR, 'layout.absent')
/** Where the operator's `tray.pid` is parked while the capture instance owns it. */
const TRAY_PID_BACKUP = path.join(SESSION_DIR, 'tray.pid.backup')

/** The scratch `%PROGRAMDATA%` the capture instance is given. */
const SCRATCH_PROGRAMDATA = path.join(SESSION_DIR, 'programdata')
export const SCRATCH_ROOT = path.join(SCRATCH_PROGRAMDATA, 'Owlette')

/**
 * The window every shot is taken at, in logical pixels.
 *
 * Wide enough for the sidebar and a detail form that is not wrapping, short
 * enough that the whole window fits a documentation column without scaling. The
 * sidebar is pinned with it, because its width is remembered in the same file.
 */
export const CAPTURE_WINDOW = { width: 1060, height: 640 } as const
export const CAPTURE_SIDEBAR_WIDTH = 288

/** The name the documentation shows for the machine being configured. */
export const CAPTURE_HOSTNAME = 'STUDIO-01'

/** Debug port for the capture instance. */
export const CDP_PORT = Number(process.env.OWLETTE_DESKTOP_CDP_PORT) || 9333

export interface DesktopSession {
  pid: number
  port: number
  root: string
}

// ─── process control (by pid, always verified) ───────────────────────────────

/** Image name of a pid, or null when it is gone or not readable. */
function imageNameOf(pid: number): string | null {
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const match = output.match(/^"([^"]+)"/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function isDesktopPid(pid: number): boolean {
  return imageNameOf(pid)?.toLowerCase() === DESKTOP_IMAGE
}

/**
 * Kill one desktop instance by pid.
 *
 * The image name is checked first and the kill is by pid alone: a name-wide
 * `taskkill /IM` would take out whatever else the operator has open, and pids
 * are recycled.
 */
function killDesktopPid(pid: number): boolean {
  if (!isDesktopPid(pid)) return false
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    return false
  }
  return true
}

/**
 * Every running `owlette-desktop.exe`, by pid.
 *
 * `tray.pid` is the app's own marker and the service's, but it can be stale —
 * an instance killed with `/F` never gets to remove it, and one started from the
 * Start menu writes it only once it has booted. The app is single-instance, so
 * *any* live instance holds the lock this pipeline needs; asking the process
 * table is the only way to be sure there is none.
 *
 * Enumeration only. Each pid is still verified and killed individually — a
 * `taskkill /IM` would be a name-wide kill, which is never what we want.
 */
function listDesktopPids(): number[] {
  try {
    const output = execFileSync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${DESKTOP_IMAGE}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
    return [...output.matchAll(/^"[^"]+","(\d+)"/gm)]
      .map((match) => Number(match[1]))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * Claim the real `tmp/tray.pid` for the capture instance.
 *
 * The service checks that file every loop tick and spawns a tray whenever it
 * does not name a live `owlette-desktop.exe` (`owlette_service._is_tray_alive`).
 * Our instance publishes its pid into the *scratch* tree, so without this the
 * service keeps launching trays at us for the whole session — and one of those
 * launches wins the single-instance lock in the moment between the kill and our
 * spawn, which costs a retry and leaves a dead icon in the notification area
 * that the tray-menu capture then tries to right-click.
 *
 * The previous contents are put back verbatim by {@link releaseTrayPid}. They
 * name the process we killed, so the file is exactly as stale as it would have
 * been anyway; the service overwrites it with the tray it spawns next.
 */
function claimTrayPid(pid: number): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  if (!fs.existsSync(TRAY_PID_BACKUP) && fs.existsSync(TRAY_PID_FILE)) {
    fs.copyFileSync(TRAY_PID_FILE, TRAY_PID_BACKUP)
  }
  try {
    fs.mkdirSync(path.dirname(TRAY_PID_FILE), { recursive: true })
    fs.writeFileSync(TRAY_PID_FILE, String(pid))
  } catch {
    // Not fatal: the service will simply keep topping the tray up, which the
    // launch retry already tolerates.
  }
}

/** Put the operator's `tray.pid` back. Safe to call when nothing was claimed. */
export function releaseTrayPid(): void {
  if (!fs.existsSync(TRAY_PID_BACKUP)) return
  try {
    fs.copyFileSync(TRAY_PID_BACKUP, TRAY_PID_FILE)
  } catch {
    // The desktop app removes this file on a clean exit; a failure to restore a
    // marker the service rewrites within 30 seconds is not worth failing on.
  }
  fs.rmSync(TRAY_PID_BACKUP, { force: true })
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isDesktopPid(pid)) return
    await delay(200)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── layout memory ───────────────────────────────────────────────────────────

/**
 * Put the operator's window size aside and pin a canonical one.
 *
 * The app rewrites this file when its window is put away and again on exit, so
 * the restore has to happen *after* the capture instance is gone —
 * {@link restoreLayout} is called from the global teardown for exactly that
 * reason.
 */
export function snapshotLayout(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  fs.rmSync(LAYOUT_BACKUP, { force: true })
  fs.rmSync(LAYOUT_ABSENT, { force: true })

  if (fs.existsSync(LAYOUT_FILE)) fs.copyFileSync(LAYOUT_FILE, LAYOUT_BACKUP)
  else fs.writeFileSync(LAYOUT_ABSENT, '')

  fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true })
  fs.writeFileSync(
    LAYOUT_FILE,
    `${JSON.stringify(
      {
        sidebar: { width: CAPTURE_SIDEBAR_WIDTH },
        window: { ...CAPTURE_WINDOW, maximized: false },
      },
      null,
      2,
    )}\n`,
  )
}

/** Put the operator's window size back exactly as it was. */
export function restoreLayout(): void {
  if (fs.existsSync(LAYOUT_BACKUP)) {
    fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true })
    fs.copyFileSync(LAYOUT_BACKUP, LAYOUT_FILE)
    fs.rmSync(LAYOUT_BACKUP, { force: true })
    return
  }
  if (fs.existsSync(LAYOUT_ABSENT)) {
    fs.rmSync(LAYOUT_FILE, { force: true })
    fs.rmSync(LAYOUT_ABSENT, { force: true })
  }
}

// ─── the scratch owlette tree ────────────────────────────────────────────────

/**
 * Build the demo `%PROGRAMDATA%\Owlette` the capture instance reads.
 *
 * `python/` is a directory junction onto the real bundled interpreter rather
 * than a copy: the app refuses to start the pairing helper unless
 * `python/python.exe` exists, and 200 MB of embedded runtime is not worth
 * duplicating per run. It is removed with `rmdir`, which deletes the link and
 * never follows it.
 */
export function buildScratchRoot(): string {
  removeScratchRoot()

  for (const relative of ['config', 'tmp', 'agent/src', 'logs']) {
    fs.mkdirSync(path.join(SCRATCH_ROOT, ...relative.split('/')), { recursive: true })
  }

  if (fs.existsSync(PYTHON_DIR)) {
    fs.symlinkSync(PYTHON_DIR, path.join(SCRATCH_ROOT, 'python'), 'junction')
  }

  return SCRATCH_ROOT
}

/** Tear the scratch tree down, link first so the junction target is untouched. */
export function removeScratchRoot(): void {
  const junction = path.join(SCRATCH_ROOT, 'python')
  if (fs.existsSync(junction)) {
    // `rmdir` on a reparse point removes the link itself. Never `rm -r` here:
    // that would be pointed at the installed interpreter.
    try {
      fs.rmdirSync(junction)
    } catch {
      fs.unlinkSync(junction)
    }
  }
  fs.rmSync(SCRATCH_PROGRAMDATA, { recursive: true, force: true })
}

/**
 * Write one of the seam files the app watches.
 *
 * Written the way the service writes them — scratch file, then rename — so the
 * host's watcher reports exactly one change and never reads half a document.
 */
export function writeSeamFile(root: string, relative: string, body: unknown): void {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const scratch = `${target}.${process.pid}.tmp`
  fs.writeFileSync(scratch, `${JSON.stringify(body, null, 4)}\n`)
  fs.renameSync(scratch, target)
}

/** Write a plain text file into the scratch tree (`agent/VERSION`). */
export function writeTextFile(root: string, relative: string, body: string): void {
  const target = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

// ─── launching the capture instance ──────────────────────────────────────────

/** Is a CDP endpoint serving a page target yet? */
async function cdpPageReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return false
    const targets = (await response.json()) as { type?: string }[]
    return targets.some((target) => target.type === 'page')
  } catch {
    return false
  }
}

/**
 * Kill the tray and start a capture instance in its place.
 *
 * The service tops the tray up on a 30-second cooldown, so it can win the race
 * for the single-instance lock in the moment between the kill and our launch —
 * in which case our process exits immediately, having forwarded its argv to the
 * service's. That is what the retry is for; each attempt kills whatever holds
 * the lock and tries again.
 */
export async function startDesktop(root: string, port: number): Promise<DesktopSession> {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const holder of listDesktopPids()) {
      killDesktopPid(holder)
      await waitForExit(holder)
    }

    const child = spawn(DESKTOP_EXE, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...process.env,
        // Everything the app reads about this machine comes from here.
        PROGRAMDATA: SCRATCH_PROGRAMDATA,
        COMPUTERNAME: CAPTURE_HOSTNAME,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
    })
    child.unref()

    const pid = child.pid
    if (pid === undefined) throw new Error('could not start owlette-desktop.exe')
    claimTrayPid(pid)

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (!isDesktopPid(pid)) break // lost the single-instance race
      if (await cdpPageReady(port)) return { pid, port, root }
      await delay(250)
    }

    killDesktopPid(pid)
    await waitForExit(pid)
  }

  throw new Error(
    `owlette-desktop.exe did not expose a debug page on port ${port} after ${attempts} attempts`,
  )
}

/** Stop the capture instance and wait for it to write its layout out. */
export async function stopDesktop(session: DesktopSession): Promise<void> {
  killDesktopPid(session.pid)
  await waitForExit(session.pid)
}

/**
 * Kill any pairing stand-in still sleeping in the scratch tree.
 *
 * The dialog cancels its helper when it closes, and the app kills every run on
 * exit — but the capture instance is stopped with `taskkill /F`, which runs
 * neither. Matching on the command line rather than the image name is what keeps
 * this from touching an unrelated python the operator has open.
 */
export function killScratchHelpers(): void {
  let output = ''
  try {
    output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${SCRATCH_ROOT.replace(/'/g, "''")}*' } | ` +
          'ForEach-Object { $_.ProcessId }',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
  } catch {
    return
  }

  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (imageNameOf(pid)?.toLowerCase() !== 'python.exe') continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Already gone.
    }
  }
}

export function readSession(): DesktopSession {
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as DesktopSession
}

export function writeSession(session: DesktopSession): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`)
}

export function clearSession(): void {
  fs.rmSync(SESSION_FILE, { force: true })
}
