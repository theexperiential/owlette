/**
 * Video-capture helpers for the tutorial pipeline.
 *
 * Recording layer: Playwright orchestrates a HEADED chromeless Chromium window
 * (--kiosk + viewport: null + DPR 1, set in `playwright.videos.config.ts`).
 * An external ffmpeg subprocess (`FfmpegRecorder`) captures the actual desktop
 * via DXGI Desktop Duplication (`ddagrab`) and encodes through `h264_nvenc` —
 * verified end-to-end by `scripts/probe-capture.mjs`. Playwright's built-in
 * `recordVideo` is no longer used: it's locked to ~25fps VP8 with opportunistic
 * frame-grabbing (right for test debugging, wrong for production tutorial video).
 *
 * Motion: scenes drive a fake on-screen cursor (headed chromium captures show no
 * OS pointer because ffmpeg's `draw_mouse=0` strips it — we keep one cursor in
 * the frame, not two), human-paced movement/typing, and `narrate()` dwells sized
 * to each rendered VO MP3 so the audio drops underneath in the editor.
 *
 * Determinism: a fixed clock is set via `page.clock.setFixedTime` BEFORE
 * navigation (Date.now stabilises so the seeded "X minutes ago" labels render
 * deterministically) — we explicitly do NOT call `clock.install`, because that
 * also fakes `setTimeout`/`setInterval`/`requestAnimationFrame` and would freeze
 * our rAF-driven scroll. The `openForCapture` helper rAF-smokes the chosen clock
 * setup so a regression that breaks rAF surfaces immediately, not 60 seconds in.
 *
 * Outputs: clean `<sceneName>.mp4` lands in `e2e/.output/videos/`.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { disableAnimations } from '../screenshots/docs-helpers';
import { FIXED_NOW_MS } from '../screenshots/fixtures';
import { FfmpegRecorder, buildPrimaryFfmpegArgs } from './ffmpeg-recorder';

/** Clean, named .mp4 output lands here. */
export const VIDEO_OUT_DIR = path.resolve(__dirname, '..', '.output', 'videos');

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;

/** Pre- and post-roll held on the start/end frame so every clip begins/ends cleanly. */
const PRE_ROLL_MS = 150;
const POST_ROLL_MS = 150;

export interface RecordSceneOptions {
  /** App origin, e.g. http://127.0.0.1:3100. */
  baseURL: string;
  /** Path to a role storageState fixture (use `roleState('admin').storageState`). */
  storageState: string;
}

/**
 * Run `scene` inside a fresh context with ffmpeg desktop capture running, and save
 * the result to `e2e/.output/videos/{sceneName}.mp4`. The recorder is started
 * BEFORE the scene callback (with a small pre-roll) and stopped after (with a
 * small post-roll) so the captured clip has stable bookends regardless of how
 * fast the scene's first/last action fires.
 *
 * If the scene throws, the recorder is still stopped cleanly in a finally — no
 * orphaned ffmpeg subprocess, no half-written file masquerading as a valid clip
 * (the temp→final rename in `FfmpegRecorder.stop` only happens on a clean exit).
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
    // Viewport + DPR inherited from the project use block in playwright.videos.config.ts.
    // Playwright resizes the chrome window so inner === VIEWPORT_WIDTH×VIEWPORT_HEIGHT.
  });
  const page = await context.newPage();
  // Fake Date.now / new Date() in the page so the seeded "X minutes ago" labels
  // render against FIXED_NOW_MS deterministically — WITHOUT going through
  // `page.clock.setFixedTime`, which despite its docs routes rAF through
  // Playwright's ClockController on the installed version and freezes our
  // in-page scroll animation. requestAnimationFrame + performance.now are
  // untouched here, since neither uses Date internally.
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

  // Chrome ships chrome UI (tabs + address bar) on top of the content viewport.
  // ddagrab captures from desktop coordinates, so we need to know where the page
  // content actually lives on the desktop before starting ffmpeg.
  //
  // Strategy: measure chrome UI height, then ATTEMPT to slide the window upward
  // by that many pixels via CDP `Browser.setWindowBounds` so its chrome UI sits
  // off-display (above desktop y=0). Re-measure to see what Windows actually
  // allowed:
  //   - If the window's screenY is negative, the chrome UI is off-display and
  //     we capture from desktop (0, 0) — full 1920×1080.
  //   - If Windows clipped the negative position to 0, the chrome UI is still
  //     on-display; we capture starting at offset_y = chromeUI height, with
  //     height clamped to whatever fits between there and the bottom of the
  //     display. Output will be 1920×(1080 − chromeUI) — about 992 — which is
  //     a real fidelity hit but never silently truncates content.
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
    args: buildPrimaryFfmpegArgs({
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
 * Inject a visible cursor that follows Playwright's mouse events, plus a click
 * ripple. Runs on every navigation (addInitScript) so it survives page transitions.
 * ffmpeg captures with `draw_mouse=0` so the OS pointer doesn't double up.
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
 * Open the dashboard (or any path) and quiet the page for capture.
 *
 * IMPORTANT ordering:
 *   1. `clock.setFixedTime` is called BEFORE navigation so the page's very first
 *      `Date.now()` (fixture hydration, "X minutes ago" labels) sees the frozen
 *      time. We use `setFixedTime` and NOT `clock.install` because `install`
 *      also fakes `requestAnimationFrame`, which would freeze our rAF scroll.
 *   2. After the page loads, we run a rAF smoke (3 frames in 500ms) so a future
 *      regression that re-introduces frozen rAF surfaces here, not 60 seconds
 *      into the first scene.
 *   3. Viewport + DPR are asserted: if Chromium didn't honor the launch args
 *      we capture at the wrong region and the editor sees blurry footage.
 */
export async function openForCapture(page: Page, urlPath: string): Promise<void> {
  // NOTE: no `page.clock.*` call here — the fake clock is applied via
  // `addInitScript` in `recordScene` (Date.now / new Date() only), which is
  // safe for rAF. Calling page.clock here would re-introduce the freeze.
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

/**
 * Dwell on the current frame for `seconds`, long enough to lay this beat's
 * narration MP3 underneath in the editor. The label is logged so you can match
 * capture to beat.
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

/**
 * Slowly pan the window from its current scroll position to the bottom over
 * `seconds`, driven by ONE in-page `requestAnimationFrame` loop with ease-in-out
 * cubic easing. The browser's native 60Hz refresh paces every frame — no CDP
 * round-trips per step, no staircase. No-op-safe: if the content already fits
 * the viewport it just dwells for `seconds`.
 *
 * (Replaces the prior 80-step CDP `window.scrollBy` staircase. The screenshots
 * harness globally disables CSS animations/transitions, so we drive `scrollTo`
 * imperatively rather than via `scrollTo({ behavior: 'smooth' })`.)
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
