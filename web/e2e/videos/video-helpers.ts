/**
 * Video-capture helpers for the tutorial pipeline. Output: `<sceneName>.mp4` in
 * `e2e/.output/videos/`.
 *
 * Playwright drives a HEADED chromeless window (`playwright.videos.config.ts`);
 * an external ffmpeg (`FfmpegRecorder`) captures the desktop via ddagrab +
 * h264_nvenc, falling back to gdigrab + libx264 on a box without DXGI/NVENC
 * (pin one path with `OWLETTE_VIDEO_CAPTURE_PATH=primary|fallback`). Playwright's
 * `recordVideo` is deliberately unused — ~25fps VP8 with opportunistic frame
 * grabs is fine for debugging, not for tutorials.
 *
 * Scenes draw a fake cursor (ffmpeg runs `draw_mouse=0`, so there is exactly one
 * pointer in frame) and `narrate()` dwells are sized to the rendered VO MP3s.
 *
 * Determinism: the clock is frozen BEFORE navigation. Never use `clock.install`
 * — it fakes rAF and freezes the scroll animation; `openForCapture` rAF-smokes
 * the setup so such a regression surfaces immediately, not 60s into a scene.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { disableAnimations } from '../screenshots/docs-helpers';
import { FIXED_NOW_MS } from '../screenshots/fixtures';
import { FfmpegRecorder, planCapturePaths } from './ffmpeg-recorder';

/** Clean, named .mp4 output lands here. */
export const VIDEO_OUT_DIR = path.resolve(__dirname, '..', '.output', 'videos');

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;

/** Held on the start/end frame so every clip has stable bookends. */
const PRE_ROLL_MS = 150;
const POST_ROLL_MS = 150;

export interface RecordSceneOptions {
  /** App origin, e.g. http://127.0.0.1:3100. */
  baseURL: string;
  /** Path to a role storageState fixture (use `roleState('admin').storageState`). */
  storageState: string;
}

/**
 * Run `scene` in a fresh context with ffmpeg desktop capture, saving to
 * `e2e/.output/videos/{sceneName}.mp4`. A throwing scene still stops the recorder
 * in `finally` — no orphaned ffmpeg, and the temp->final rename in
 * `FfmpegRecorder.stop` means a half-written file never poses as a valid clip.
 */
export async function recordScene(
  browser: Browser,
  sceneName: string,
  opts: RecordSceneOptions,
  scene: (page: Page) => Promise<void>,
): Promise<string> {
  await mkdir(VIDEO_OUT_DIR, { recursive: true });
  const outPath = path.join(VIDEO_OUT_DIR, `${sceneName}.mp4`);

  const context = await browser.newContext({
    baseURL: opts.baseURL,
    storageState: opts.storageState,
    // viewport + DPR come from the project use block in playwright.videos.config.ts
  });
  const page = await context.newPage();
  // Freeze Date only, so seeded "X minutes ago" labels are deterministic. NOT
  // `page.clock.setFixedTime`: on the installed version it routes rAF through
  // Playwright's ClockController and freezes the in-page scroll animation.
  await page.addInitScript((fixedTime: number) => {
    const RealDate = Date;
    const FakeDate = class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(fixedTime);
        else super(...(args as ConstructorParameters<typeof RealDate>));
      }
      static now(): number { return fixedTime; }
    };
    FakeDate.UTC = RealDate.UTC;
    FakeDate.parse = RealDate.parse;
    (window as unknown as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;
  }, FIXED_NOW_MS);
  await installFakeCursor(page);

  // ddagrab captures desktop coordinates, so locate the content area first.
  // Measure the chrome UI height, then try to slide the window up by that much
  // (CDP setWindowBounds) so the UI sits above desktop y=0. Re-measure: negative
  // screenY means we capture the full 1920x1080 from (0,0); if Windows clamped
  // the move to 0 we capture from offset_y = chromeUI with the height clipped to
  // the display — lower fidelity, but never a silent content truncation.
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  const initialGeom = await page.evaluate(() => ({
    offsetY: window.outerHeight - window.innerHeight,
    contentWidth: window.innerWidth,
    contentHeight: window.innerHeight,
  }));
  if (initialGeom.contentWidth !== VIEWPORT_WIDTH || initialGeom.contentHeight !== VIEWPORT_HEIGHT) {
    await context.close();
    throw new Error(
      `pre-capture geometry mismatch: page innerWidth/innerHeight = ${initialGeom.contentWidth}×${initialGeom.contentHeight}, expected ${VIEWPORT_WIDTH}×${VIEWPORT_HEIGHT}. ` +
      `Project use should set viewport to { width: ${VIEWPORT_WIDTH}, height: ${VIEWPORT_HEIGHT} }.`,
    );
  }

  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: -initialGeom.offsetY },
    });
  } catch (e) {
    console.warn(`[recordScene] CDP setWindowBounds failed (continuing with clamped capture): ${e}`);
  }
  await page.waitForTimeout(300);

  const finalScreenY = await page.evaluate(() => window.screenY);
  const movedOffDisplay = finalScreenY < 0;
  const displayHeight = 1080;
  const captureOffsetY = movedOffDisplay ? 0 : initialGeom.offsetY;
  const captureHeight = movedOffDisplay
    ? VIEWPORT_HEIGHT
    : Math.min(VIEWPORT_HEIGHT, displayHeight - initialGeom.offsetY);
  console.log(
    `[recordScene] capture region: ${VIEWPORT_WIDTH}×${captureHeight} ` +
    `at (0, ${captureOffsetY})  ` +
    `[window screenY=${finalScreenY}, chromeUI=${initialGeom.offsetY}px, ` +
    `movedOffDisplay=${movedOffDisplay}]`,
  );

  const recorder = new FfmpegRecorder({
    outPath,
    paths: planCapturePaths({
      offsetX: 0,
      offsetY: captureOffsetY,
      width: VIEWPORT_WIDTH,
      height: captureHeight,
    }),
    onStderr: (line) => {
      if (/error|fatal/i.test(line)) console.warn(`[ffmpeg] ${line}`);
    },
  });

  await recorder.start();
  await page.waitForTimeout(PRE_ROLL_MS);

  let sceneError: unknown = null;
  try {
    await scene(page);
    await page.waitForTimeout(POST_ROLL_MS);
  } catch (e) {
    sceneError = e;
  } finally {
    try { await recorder.stop(); } catch (stopErr) {
      console.warn(`[recordScene] recorder.stop error: ${stopErr}`);
    }
    try { await context.close(); } catch { /* best-effort */ }
  }

  if (sceneError) throw sceneError;
  return outPath;
}

/**
 * Visible cursor following Playwright's mouse events, plus a click ripple.
 * Re-injected on every navigation. ffmpeg runs `draw_mouse=0` so it can't double up.
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

/**
 * Open a path and quiet the page for capture. Asserts viewport + DPR (wrong
 * launch args = wrong capture region and blurry footage) and rAF-smokes 3 frames
 * in 500ms so a re-frozen rAF fails here, not 60s into the first scene.
 */
export async function openForCapture(page: Page, urlPath: string): Promise<void> {
  // No `page.clock.*` here — the fake clock is Date-only via addInitScript in
  // recordScene; page.clock would re-freeze rAF.
  await page.goto(urlPath, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await disableAnimations(page);

  const geom = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  if (geom.w !== VIEWPORT_WIDTH || geom.h !== VIEWPORT_HEIGHT) {
    throw new Error(
      `capture geometry mismatch: viewport ${geom.w}x${geom.h} != ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}. ` +
      `Check the videos config's --window-size / --kiosk launch args and your monitor's Windows scaling (must be 100%).`,
    );
  }
  if (geom.dpr !== 1) {
    throw new Error(
      `capture DPR mismatch: devicePixelRatio ${geom.dpr} != 1. ` +
      `Set the primary monitor to 100% Windows scaling and re-launch.`,
    );
  }

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    let ticks = 0;
    const fail = setTimeout(
      () => reject(new Error('rAF smoke failed: < 3 callbacks within 500ms — clock setup has frozen requestAnimationFrame')),
      500,
    );
    function step(): void {
      ticks += 1;
      if (ticks >= 3) { clearTimeout(fail); resolve(); }
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }));
}

/** Dwell long enough to lay this beat's narration MP3 underneath in the editor. */
export async function narrate(page: Page, beat: string, seconds: number): Promise<void> {
  console.log(`  [vo] ${beat} (~${seconds}s)`);
  await page.waitForTimeout(Math.round(seconds * 1000));
}

/** Glide, not teleport — the movement has to read on screen. */
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

/**
 * Pan to the bottom over `seconds` from ONE in-page rAF loop, so the browser's
 * 60Hz paces every frame — a per-step CDP scrollBy staircases. Imperative
 * `scrollTo` because the harness globally disables CSS animation, which kills
 * `behavior: 'smooth'`. Dwells for `seconds` if the content already fits.
 */
export async function slowScrollToBottom(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    ({ duration }) => new Promise<void>((resolve) => {
      const startY = window.scrollY;
      const targetY = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      );
      if (targetY - startY < 8) {
        setTimeout(resolve, duration);
        return;
      }
      const t0 = performance.now();
      const ease = (t: number): number =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      function step(now: number): void {
        const p = Math.min(1, (now - t0) / duration);
        window.scrollTo(0, startY + (targetY - startY) * ease(p));
        if (p < 1) requestAnimationFrame(step);
        else {
          window.scrollTo(0, targetY);
          resolve();
        }
      }
      requestAnimationFrame(step);
    }),
    { duration: seconds * 1000 },
  );
}

/** Center an element in the viewport (for "zoom into one card" style framing). */
export async function centerInView(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: Element) =>
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }),
  );
}
