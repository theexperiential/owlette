/**
 * Page helpers for the desktop-app video harness — the `e2e/videos` helpers of
 * the same names, ported to a page we ATTACHED to rather than one we created.
 *
 * The web originals live in `e2e/videos/video-helpers.ts` and are deliberately
 * left alone: they own scene lifecycle (context creation, the fake clock, the
 * chrome-UI capture offset) which has no meaning here. What is shared is the
 * pixel path — `e2e/videos/ffmpeg-recorder.ts` — imported unchanged by
 * `./harness`.
 *
 * Two differences that matter, both forced by `connectOverCDP`:
 *
 * 1. The app never navigates, so `addInitScript` alone would never run: the
 *    cursor is evaluated into the LIVE document as well as registered for the
 *    next document (the app menu's `reload window` is a real navigation, and a
 *    take that used it would otherwise lose its pointer).
 * 2. Animations are NOT disabled. The stills harness zeroes them because a
 *    mid-transition frame is a byte diff; this is video, where the 200 ms
 *    launch-mode slide and the dialog fades are part of what the episode is
 *    teaching. Determinism here comes from the fixtures and the pinned pairing
 *    phrase, not from a frozen compositor.
 */

import type { Locator, Page } from '@playwright/test';

/**
 * Visible cursor following Playwright's mouse events, plus a click ripple.
 * ffmpeg runs `draw_mouse=0`, so this is the only pointer in frame.
 *
 * Self-contained by necessity — it is serialized into the webview, so it may
 * close over nothing from this module.
 */
function mountFakeCursor(): void {
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
}

/** Draw the fake pointer now, and again after any reload. Idempotent. */
export async function installFakeCursor(page: Page): Promise<void> {
  await page.addInitScript(mountFakeCursor);
  await page.evaluate(mountFakeCursor);
}

/** Dwell long enough to lay this beat's narration MP3 underneath in the editor. */
// Beat-timing enforcement, sidecars, and the edge audit are shared with the
// web harness — same manifests, same guarantees (footage ≥ narration per beat,
// `<scene>.beats.json` ground truth for the Resolve conform, pixel edge check).
// The machinery only uses page.waitForTimeout + the node clock, so it works
// identically on an attached CDP page.
export { narrate, beginTake, finishTake, assertEdgesClean } from '../videos/video-helpers';

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

/** Right-click an element from where the pointer already is — the row menus. */
export async function rightClickWithCursor(page: Page, locator: Locator): Promise<void> {
  await moveCursorTo(page, locator);
  await page.waitForTimeout(250);
  await locator.click({ button: 'right' });
}

/**
 * Type into a field one character at a time so the keystrokes read on screen.
 * Blurring is the caller's job here, not the helper's: the detail pane saves on
 * blur, so when that write is the point of the beat it has to be deliberate.
 */
export async function typewrite(
  page: Page,
  locator: Locator,
  text: string,
  perCharMs = 55,
): Promise<void> {
  await clickWithCursor(page, locator);
  await locator.fill('');
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
 * Park the pointer somewhere inert.
 *
 * The footer's middle is the one large region of this window with no hover
 * state and nothing to press: its call-to-action button is hard left and the
 * version label hard right. NOT the titlebar — it carries
 * `data-tauri-drag-region`, so a press there would start a window drag and move
 * the capture region out from under ffmpeg.
 */
export async function parkPointer(page: Page): Promise<void> {
  const box = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await page.mouse.move(Math.round(box.width / 2), Math.round(box.height - 14), { steps: 12 });
}

/** Drop focus a previous step left behind — it draws a ring in the next frame. */
export async function clearFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/** Everything has arrived and stopped moving. */
export async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(ms);
}

/**
 * Drag a process row to a new position, as an operator does — a real pointer
 * press, a slow move past the intervening row midpoints, and a release.
 *
 * `ProcessList` starts its drag from raw pointer events with a 6 px threshold
 * and tracks the drop gap by comparing the pointer's y against each row's
 * midpoint, so this has to move in steps: one jump from press to release lands
 * the gap correctly but shows no travel, and the blue drop indicator — the
 * thing the beat is about — never renders.
 *
 * The release lands NEAR THE TOP of the target row, not on its midpoint.
 * `gapFor` counts midpoints with a strict `y > midpoint`, so releasing exactly
 * on `to.y + to.height / 2` sits on the boundary of that test: it resolves the
 * way this helper intends only while the row geometry keeps the midpoint an
 * integer, and flips to the next gap the moment a row height or the list's
 * spacing makes it fractional and the client y rounds up. A few px inside the
 * row's top half is the same drop index with none of that sensitivity.
 */
export async function dragRowTo(page: Page, row: Locator, target: Locator): Promise<void> {
  const from = await row.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('dragRowTo: a row has no bounding box (not visible?)');

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const dropY = to.y + Math.min(8, to.height / 3);
  await page.mouse.move(startX, startY, { steps: 18 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  // Past the 6 px threshold first, so the lift reads before the travel starts.
  await page.mouse.move(startX, startY - 10, { steps: 6 });
  await page.waitForTimeout(200);
  await page.mouse.move(startX, dropY, { steps: 28 });
  await page.waitForTimeout(400);
  await page.mouse.up();
}
