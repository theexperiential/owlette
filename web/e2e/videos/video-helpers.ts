/**
 * Video-capture helpers for the tutorial pipeline.
 *
 * The screenshots harness froze a single frame; here we capture motion, so we add:
 *   - a fake on-screen cursor (headless Chromium has no OS pointer, so recorded video
 *     would otherwise show clicks happening with no visible mouse),
 *   - human-paced movement / typing so the footage is watchable,
 *   - `narrate()` dwell gaps so each beat lingers long enough to lay its MP3 underneath.
 *
 * Determinism is inherited from the screenshots harness: fixed clock + disabled
 * animations (see ../screenshots/docs-helpers.ts), seeded fixture data
 * (../screenshots/fixtures.ts).
 *
 * Scenes drive their own browser context via `recordScene()` so each .webm is named
 * after the episode/scene rather than Playwright's auto hash.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { disableAnimations } from '../screenshots/docs-helpers';
import { FIXED_NOW_MS } from '../screenshots/fixtures';

/** Clean, named .webm output lands here. */
export const VIDEO_OUT_DIR = path.resolve(__dirname, '..', '.output', 'videos');
/** Raw per-context recordings (auto-named) land here before being copied out. */
const VIDEO_RAW_DIR = path.resolve(__dirname, '..', '.output', 'videos-raw');

const VIEWPORT = { width: 1920, height: 1080 } as const;

export interface RecordSceneOptions {
  /** App origin, e.g. http://127.0.0.1:3100. */
  baseURL: string;
  /** Path to a role storageState fixture (use roleState('admin').storageState). */
  storageState: string;
}

/**
 * Run `scene` inside a fresh recorded context and save the result to
 * `e2e/.output/videos/{sceneName}.webm`. A fixed clock is installed before the scene
 * runs so relative timestamps match the seeded fixture data.
 */
export async function recordScene(
  browser: Browser,
  sceneName: string,
  opts: RecordSceneOptions,
  scene: (page: Page) => Promise<void>,
): Promise<string> {
  await mkdir(VIDEO_RAW_DIR, { recursive: true });
  await mkdir(VIDEO_OUT_DIR, { recursive: true });

  const context = await browser.newContext({
    baseURL: opts.baseURL,
    storageState: opts.storageState,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_RAW_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  await installFakeCursor(page);
  await page.clock.install({ time: FIXED_NOW_MS });

  await scene(page);

  const video = page.video();
  await context.close(); // finalizes the recording
  const target = path.join(VIDEO_OUT_DIR, `${sceneName}.webm`);
  if (video) await video.saveAs(target);
  return target;
}

/**
 * Inject a visible cursor that follows Playwright's mouse events, plus a click ripple.
 * Runs on every navigation (addInitScript) so it survives page transitions.
 */
export async function installFakeCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const CURSOR_ID = '__owl_cursor__';
    const mount = (): void => {
      if (!document.body || document.getElementById(CURSOR_ID)) return;
      const cursor = document.createElement('div');
      cursor.id = CURSOR_ID;
      cursor.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'z-index:2147483647',
        'width:20px', 'height:20px', 'margin:-2px 0 0 -2px', 'pointer-events:none',
        'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
      ].join(';');
      cursor.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1.2">' +
        '<path d="M5 3l14 7-6 1.5L10 18z"/></svg>';
      document.body.appendChild(cursor);

      window.addEventListener(
        'mousemove',
        (e) => {
          cursor.style.left = `${e.clientX}px`;
          cursor.style.top = `${e.clientY}px`;
        },
        true,
      );
      window.addEventListener(
        'mousedown',
        (e) => {
          const ripple = document.createElement('div');
          ripple.style.cssText = [
            'position:fixed', `left:${e.clientX - 14}px`, `top:${e.clientY - 14}px`,
            'width:28px', 'height:28px', 'border-radius:50%', 'pointer-events:none',
            'z-index:2147483646', 'border:2px solid rgba(99,102,241,0.95)',
          ].join(';');
          document.body.appendChild(ripple);
          ripple
            .animate(
              [
                { transform: 'scale(0.3)', opacity: 1 },
                { transform: 'scale(1.8)', opacity: 0 },
              ],
              { duration: 450, easing: 'ease-out' },
            )
            .addEventListener('finish', () => ripple.remove());
        },
        true,
      );
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount);
  });
}

/** Open the dashboard (or any path) and quiet the page for capture. */
export async function openForCapture(page: Page, urlPath: string): Promise<void> {
  await page.goto(urlPath, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200); // let Firestore listeners hydrate the fixture data
  await disableAnimations(page);
  await page.clock.setFixedTime(FIXED_NOW_MS);
}

/**
 * Dwell on the current frame for `seconds`, long enough to lay this beat's narration
 * MP3 underneath in the editor. The label is logged so you can match capture to beat.
 */
export async function narrate(page: Page, beat: string, seconds: number): Promise<void> {
  console.log(`  [vo] ${beat} (~${seconds}s)`);
  await page.waitForTimeout(Math.round(seconds * 1000));
}

/** Glide the cursor to an element's center (visible movement, not a teleport). */
export async function moveCursorTo(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('moveCursorTo: target has no bounding box (not visible?)');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
}

/** Move to an element, pause a beat, then click it. */
export async function clickWithCursor(page: Page, locator: Locator): Promise<void> {
  await moveCursorTo(page, locator);
  await page.waitForTimeout(250);
  await locator.click();
}

/** Type into a field one character at a time so the keystrokes read on screen. */
export async function typewrite(
  page: Page,
  locator: Locator,
  text: string,
  perCharMs = 55,
): Promise<void> {
  await clickWithCursor(page, locator);
  await locator.pressSequentially(text, { delay: perCharMs });
}

/** Briefly outline an element to draw the eye (auto-clears). */
export async function highlight(page: Page, locator: Locator, ms = 1400): Promise<void> {
  await moveCursorTo(page, locator);
  await locator.evaluate((el: SVGElement | HTMLElement, dur: number) => {
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid rgba(99,102,241,0.95)';
    el.style.outlineOffset = '3px';
    window.setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, dur);
  }, ms);
}
