/**
 * Launch the desktop app against the SANDBOX and attach to its WebView2.
 *
 * Playwright's documented route into a WebView2 host is a CDP endpoint opened by
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`, then
 * `chromium.connectOverCDP`. `window.__TAURI_INTERNALS__` is non-configurable, so
 * `invoke` cannot be stubbed from the page: everything the window shows comes
 * from files it reads under `%PROGRAMDATA%\Owlette` (`src-tauri/src/paths.rs`),
 * which is exactly why pointing PROGRAMDATA at the sandbox is enough to make it
 * a participant in this suite rather than a spectator.
 *
 * Process control is shared with `e2e/desktop-screenshots/harness.ts` rather than
 * copied — same binary, same single-instance trap, same kill-by-verified-pid
 * rule. What is NOT shared is the data root: the screenshots harness publishes
 * into its own capture scratch tree, and this suite must publish into the one the
 * agent is watching.
 *
 * The single-instance lock means the OPERATOR'S TRAY IS KILLED to run this. The
 * README says so; there is no way around it short of a second machine.
 */

import { chromium, type Browser, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cdpPageReady,
  isDesktopPid,
  killDesktopPid,
  listDesktopPids,
  resolveDesktopExe,
  waitForExit,
} from '../desktop-screenshots/harness'
import { OUTPUT_DIR, agentEnv, assertSandboxSafe } from './sandbox'

const DESKTOP_SESSION_FILE = path.join(OUTPUT_DIR, 'desktop-session.json')

export const CDP_PORT = Number(process.env.OWLETTE_DESKTOP_SYNC_CDP_PORT) || 9334

interface DesktopProcess {
  pid: number
  port: number
  webviewUserData: string
}

/** True when a repo-built (or installed) exe was named for this run. */
export function desktopExeConfigured(): boolean {
  return Boolean(process.env.OWLETTE_DESKTOP_EXE)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Start the app on the sandbox and wait for its debug page.
 *
 * Retries the way the screenshots harness does: the service (or a Start-menu
 * launch) can win the single-instance lock in the gap between our kill and our
 * spawn, in which case our process forwards argv and exits immediately.
 */
export async function startDesktopOnSandbox(programData: string): Promise<DesktopProcess> {
  assertSandboxSafe(programData)
  const exe = resolveDesktopExe()
  if (!fs.existsSync(exe)) {
    throw new Error(
      `OWLETTE_DESKTOP_EXE points at a file that does not exist: ${exe}\n` +
        'Build it first: cd desktop && npx tauri build --no-bundle',
    )
  }

  const webviewUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'owlette-sync-webview2-'))
  const attempts = 3

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const holder of listDesktopPids()) {
      killDesktopPid(holder)
      await waitForExit(holder)
    }

    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: agentEnv(programData, {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: webviewUserData,
      }),
    })
    child.unref()

    const pid = child.pid
    if (pid === undefined) throw new Error(`could not start ${exe}`)

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (!isDesktopPid(pid)) break // lost the single-instance race
      if (await cdpPageReady(CDP_PORT)) {
        const session = { pid, port: CDP_PORT, webviewUserData }
        fs.mkdirSync(OUTPUT_DIR, { recursive: true })
        fs.writeFileSync(DESKTOP_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`)
        return session
      }
      await delay(250)
    }

    killDesktopPid(pid)
    await waitForExit(pid)
  }

  fs.rmSync(webviewUserData, { recursive: true, force: true })
  throw new Error(
    `${exe} did not expose a debug page on port ${CDP_PORT} after ${attempts} attempts`,
  )
}

/** Attach to the running app's webview. Returns both so the caller can detach. */
export async function connectDesktopPage(
  port: number,
): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const pages = browser.contexts()[0]?.pages() ?? []
  const page = pages.find((candidate) => candidate.url().includes('tauri.localhost'))
  if (!page) {
    await browser.close()
    throw new Error(
      `no owlette webview on the debug port (saw: ${pages.map((p) => p.url()).join(', ') || 'nothing'})`,
    )
  }
  return { browser, page }
}

/** Stop whatever `startDesktopOnSandbox` left running. Safe when nothing did. */
export async function stopDesktopSession(): Promise<void> {
  let session: DesktopProcess
  try {
    session = JSON.parse(fs.readFileSync(DESKTOP_SESSION_FILE, 'utf8')) as DesktopProcess
  } catch {
    return
  }

  killDesktopPid(session.pid)
  await waitForExit(session.pid)

  // Only after the wait — WebView2 holds locks for as long as its browser
  // process lives.
  try {
    fs.rmSync(session.webviewUserData, { recursive: true, force: true })
  } catch {
    // A lingering msedgewebview2.exe child; the OS reclaims the temp dir.
  }
  fs.rmSync(DESKTOP_SESSION_FILE, { force: true })
}

/**
 * Kill any helper the app spawned into the sandbox. Matched on command line, not
 * image name, so the operator's own python processes survive.
 */
export function killSandboxHelpers(programData: string): void {
  assertSandboxSafe(programData)
  let output = ''
  try {
    output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${programData.replace(/'/g, "''")}*' } | ` +
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
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // Already gone.
    }
  }
}
