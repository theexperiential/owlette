/**
 * Screenshots of the owlette desktop app for the agent docs. Driven over CDP
 * against the release binary at `C:\ProgramData\Owlette\app\owlette-desktop.exe`
 * with a scratch `%PROGRAMDATA%` of fixtures (see `harness.ts` / `fixtures.ts`).
 * Output: `web/public/docs-screens/`, referenced by `web/content/docs/agent/*.mdx`.
 *
 * Serial by construction — one window, and each scenario replaces the previous
 * one's seam files underneath it.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { DEMO_PAIR_PHRASE, seedScenario, type Scenario } from './fixtures'
import { CAPTURE_HOSTNAME, SCRATCH_ROOT, readSession } from './harness'

const DOCS_DIR = 'public/docs-screens'

/**
 * Nothing may still be moving when the shutter opens: the launch-mode indicator
 * slides for 200 ms and Radix fades overlays in — mid-animation shots diff
 * between runs.
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
  // Only disconnects the webview — global teardown stops the app and restores
  // the layout file.
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

  // The list may already look right, so the footer is the only proof the new
  // `config.json` was read.
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
  // The dialog autofocuses the block-name field with its text selected; a caret
  // and selection highlight are not part of the UI.
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
  // Enrolled but unconfigured — the state the drop hint is written for.
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
 * Last, because it is the only step that takes the pointer. The tray menu is a
 * native Win32 popup that CDP can't reach, so UI Automation captures it; its
 * hostname/version are the fixture's, from the same capture instance.
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
      // Disambiguates our tray button from a not-yet-pruned predecessor.
      '-ExpectHostname',
      CAPTURE_HOSTNAME,
    ],
    { encoding: 'utf8', windowsHide: true },
  )

  expect(output).toContain('wrote')
  expect(fs.statSync(target).size).toBeGreaterThan(1000)
})
