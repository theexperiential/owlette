/**
 * Pins the `page.clock` primitive the countdown specs rely on: install anchors
 * Date.now(), pauseAt + fastForward shift it without wall-clock delay, and
 * setTimeout callbacks fire on fast-forward.
 *
 * install must run BEFORE page load or the page's own Date.now()/timer
 * callsites miss the fake. Asserted on about:blank so this tests the primitive
 * only — the app-level case is the reboot-countdown spec.
 */

import { test, expect } from '@playwright/test';

// Unauthenticated: a clock-primitive test needs no app.
test.use({ storageState: { cookies: [], origins: [] } });

// Well in the past, so a wall-clock reading can never accidentally match.
const ANCHOR = new Date('2024-01-15T12:00:00Z');
const ANCHOR_MS = ANCHOR.getTime();

test('setFixedTime pins Date.now() exactly at the anchor', async ({ page }) => {
  // `install({ time })` starts the clock ticking and `pauseAt(t)` rejects a
  // past `t`, so a frozen Date.now() needs `setFixedTime`.
  await page.clock.install({ time: ANCHOR });
  await page.goto('about:blank');
  await page.clock.setFixedTime(ANCHOR);

  const readback = await page.evaluate(() => Date.now());
  expect(readback).toBe(ANCHOR_MS);
});

test('fastForward advances the fake clock without wall-clock delay', async ({ page }) => {
  // The fake clock ticks during `page.goto`, so pause 5 minutes ahead of the
  // anchor to stay in its future regardless of startup jitter.
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
