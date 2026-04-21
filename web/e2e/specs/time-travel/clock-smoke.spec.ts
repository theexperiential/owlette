/**
 * Time-travel — page.clock smoke test (E1.1)
 *
 * Before E1.2+ rely on `page.clock` to drive countdown assertions,
 * this spec proves the primitive works end-to-end:
 *   - `page.clock.install()` with a fixed `time` anchor sets the
 *     browser's Date.now() / new Date() / setInterval to that anchor.
 *   - `page.clock.pauseAt()` + `fastForward()` shift the fake clock
 *     without waiting wall-clock seconds.
 *   - `setTimeout` callbacks fire on fast-forward (validated via a
 *     sentinel window flag set by the timer).
 *
 * Playwright's page.clock requires the install to happen BEFORE the
 * page loads (or addInitScript) so the page's own Date.now()/timer
 * callsites pick up the fake. Asserting in an empty page (about:blank)
 * avoids the "does the clock affect our app's listeners" concern —
 * that's what E1.2's reboot-countdown spec is for. This one just pins
 * the primitive.
 */

import { test, expect } from '@playwright/test';

// Unauthenticated context — we don't need the app for a clock-primitive test.
test.use({ storageState: { cookies: [], origins: [] } });

// Fixed anchor well in the past so we can be certain the fake is taking
// effect (no risk of flaking against the wall clock).
const ANCHOR = new Date('2024-01-15T12:00:00Z');
const ANCHOR_MS = ANCHOR.getTime();

test('setFixedTime pins Date.now() exactly at the anchor', async ({ page }) => {
  // `install({ time })` sets an anchor and starts the clock ticking;
  // `pauseAt(t)` only works with `t` in the fake clock's FUTURE (errors
  // with "cannot fast-forward to the past" otherwise). For a frozen
  // Date.now(), `setFixedTime(t)` is the right primitive — it overrides
  // Date() without freezing timers.
  await page.clock.install({ time: ANCHOR });
  await page.goto('about:blank');
  await page.clock.setFixedTime(ANCHOR);

  const readback = await page.evaluate(() => Date.now());
  expect(readback).toBe(ANCHOR_MS);
});

test('fastForward advances the fake clock without wall-clock delay', async ({ page }) => {
  // `pauseAt(t)` requires `t` to be in the fake clock's future — and the
  // fake clock has already ticked some ms past `install` during
  // `page.goto`. Use a pause point 5 minutes ahead of anchor to guarantee
  // we're in the future regardless of startup jitter.
  const PAUSE_OFFSET_MS = 5 * 60 * 1000;
  await page.clock.install({ time: ANCHOR });
  await page.goto('about:blank');
  await page.clock.pauseAt(new Date(ANCHOR_MS + PAUSE_OFFSET_MS));
  await page.clock.fastForward(30_000);

  const readback = await page.evaluate(() => Date.now());
  expect(readback).toBe(ANCHOR_MS + PAUSE_OFFSET_MS + 30_000);
});

test('setTimeout callbacks fire when the fake clock advances past them', async ({ page }) => {
  const PAUSE_OFFSET_MS = 5 * 60 * 1000;
  await page.clock.install({ time: ANCHOR });
  await page.goto('about:blank');
  await page.clock.pauseAt(new Date(ANCHOR_MS + PAUSE_OFFSET_MS));

  await page.evaluate(() => {
    (window as unknown as { __clockFired: boolean }).__clockFired = false;
    setTimeout(() => {
      (window as unknown as { __clockFired: boolean }).__clockFired = true;
    }, 10_000);
  });

  expect(await page.evaluate(() => (window as unknown as { __clockFired: boolean }).__clockFired)).toBe(false);

  await page.clock.fastForward(11_000);

  expect(await page.evaluate(() => (window as unknown as { __clockFired: boolean }).__clockFired)).toBe(true);
});
