/**
 * The agent documentation's screenshots of the owlette desktop app.
 *
 * These are taken from the release binary at
 * `C:\ProgramData\Owlette\app\owlette-desktop.exe`, attached to over CDP, with a
 * scratch `%PROGRAMDATA%` full of fixture data — see `harness.ts` for why that
 * is the only honest way to drive it, and `fixtures.ts` for the machine being
 * shown. Output lands in `web/public/docs-screens/`, which
 * `web/content/docs/agent/*.mdx` references directly.
 *
 * Serial by construction: there is one window, and each scenario is the previous
 * one's seam files replaced underneath it.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { DEMO_PAIR_PHRASE, seedScenario, type Scenario } from './fixtures'
import { CAPTURE_HOSTNAME, SCRATCH_ROOT, readSession } from './harness'

const DOCS_DIR = 'public/docs-screens'

/**
 * Nothing may still be moving when the shutter opens. The launch-mode indicator
 * slides for 200 ms and Radix fades its overlays in; a screenshot taken mid-way
 * through either is the difference between two runs producing the same file and
 * two runs producing a diff.
 */
const NO_MOTION = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`

/** Somewhere inert to park the pointer: the titlebar has no hover state. */
const POINTER_PARK = { x: 420, y: 5 }

let browser: Browser
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const session = readSession()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`)

  const pages = browser.contexts()[0]?.pages() ?? []
  const found = pages.find((candidate) => candidate.url().includes('tauri.localhost'))
  if (!found) {
    throw new Error(`no owlette webview on the debug port (saw: ${pages.map((p) => p.url()).join(', ')})`)
  }
  page = found

  await page.addStyleTag({ content: NO_MOTION })
  fs.mkdirSync(DOCS_DIR, { recursive: true })
})

test.afterAll(async () => {
  // Disconnects from the webview; the app itself is stopped by the global
  // teardown, which also has the layout file to put back.
  await browser?.close()
})

/** Drop focus the previous test left behind — it draws a ring in the next shot. */
async function clearFocus(): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

/** Swap the machine under the window and wait for the app to have re-read it. */
async function useScenario(scenario: Scenario): Promise<void> {
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  seedScenario(SCRATCH_ROOT, scenario)
  if (scenario === 'paired') await expect(page.getByTestId('process-row')).toHaveCount(3)
  else await expect(page.getByTestId('process-list-empty')).toBeVisible()

  // The list can already be in the shape the next scenario wants, so the footer
  // is what proves the new `config.json` has actually been read.
  await expect(page.getByTestId('footer-status')).toContainText(
    scenario === 'unpaired' ? 'disabled' : 'connected',
  )
}

/** Select a process by the name the sidebar shows, leaving no hover behind. */
async function selectProcess(name: string): Promise<void> {
  await page.getByTestId('process-row').filter({ hasText: name }).click()
  await expect(page.locator('#name')).toHaveValue(name)
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)
}

/** Everything has arrived and stopped moving. */
async function settle(): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(300)
}

async function shoot(name: string, target?: Locator): Promise<void> {
  await settle()
  await (target ?? page).screenshot({ path: `${DOCS_DIR}/${name}` })
}

/** The right-hand pane, identified by the control only it contains. */
function detailPanel(): Locator {
  return page.locator('section').filter({ has: page.getByTestId('launch-mode') })
}

test('a configured machine: process list and per-process detail', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')
  await expect(page.getByTestId('detail-status')).toHaveText('running')

  await shoot('agent.png')
})

test('launch modes: the segmented control and a scheduled process', async () => {
  await useScenario('paired')
  await selectProcess('lobby kiosk')
  await expect(page.getByTestId('launch-mode-scheduled')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('schedule-note')).toBeVisible()

  await shoot('agent-launch-mode.png', detailPanel())
})

test('the schedule editor', async () => {
  await useScenario('paired')
  await selectProcess('lobby kiosk')

  await page.getByTestId('edit-schedule').click()
  await expect(page.getByTestId('schedule-editor')).toBeVisible()
  // The dialog autofocuses the block-name field, which opens with its text
  // selected — a caret and a selection highlight are not part of the UI.
  await clearFocus()
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-schedule-editor.png')

  // Escape discards the draft; `save schedule` is the only path that writes.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('schedule-editor')).toBeHidden()
})

test('the app menu', async () => {
  await useScenario('paired')
  await selectProcess('gallery show')

  await page.getByTestId('app-menu-trigger').click()
  await expect(page.getByTestId('menu-leave-site')).toBeVisible()

  await shoot('agent-menu.png')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('menu-leave-site')).toBeHidden()
})

test('a machine with nothing to supervise yet', async () => {
  // Enrolled but unconfigured — the state every machine passes through, and the
  // one the drop hint is written for.
  await useScenario('paired-empty')

  await shoot('agent-empty.png')
})

test('joining a site', async () => {
  await useScenario('unpaired')

  await page.getByTestId('app-menu-trigger').click()
  await page.getByTestId('menu-join-site').click()

  const dialog = page.getByTestId('join-site-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('join-phrase')).toContainText(DEMO_PAIR_PHRASE)
  await page.mouse.move(POINTER_PARK.x, POINTER_PARK.y)

  await shoot('agent-join-site.png')

  // Closing cancels the helper, exactly as it does for a real pairing run.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(500)
})

/**
 * Last, because it is the only step that takes the pointer.
 *
 * The tray menu is a native Win32 popup — no webview, nothing CDP can reach —
 * so it is captured by UI Automation instead. Its contents come from the same
 * capture instance every other shot does, which is why the hostname and version
 * in it are the fixture's rather than this machine's.
 */
test('the tray right-click menu', async () => {
  await useScenario('paired')

  const script = path.resolve('e2e/desktop-screenshots/capture-tray-menu.ps1')
  const target = path.resolve(DOCS_DIR, 'agent-right-click.png')

  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Out',
      target,
      // Tells the script which of the notification area's owlette buttons is
      // ours, when the one it replaced has not been pruned yet.
      '-ExpectHostname',
      CAPTURE_HOSTNAME,
    ],
    { encoding: 'utf8', windowsHide: true },
  )

  expect(output).toContain('wrote')
  expect(fs.statSync(target).size).toBeGreaterThan(1000)
})
