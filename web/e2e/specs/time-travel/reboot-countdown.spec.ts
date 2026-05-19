/**
 * Time-travel — reboot countdown tick (E1.2)
 *
 * MachineStatusPill's active state renders MM:SS countdown text from
 * `Math.max(0, rebootScheduledAt - now)`, where `now` is driven by a
 * `setInterval(1000)` reading `Date.now() / 1000` (components/MachineStatusPill.tsx:49).
 *
 * This spec uses `page.clock` to advance the browser's clock and
 * asserts the visible countdown text updates in lockstep. Anchor is
 * aligned to real "now" so the seeded `rebootScheduledAt` (written
 * with real Date.now()) stays on the same timeline as the fake
 * clock — using a fixed-past anchor would make the countdown read
 * "many months" since rebootScheduledAt was set with real time.
 *
 * Lessons from E1.1 applied here:
 *   - After `install`, the clock ticks — pause it so countdown
 *     assertions are deterministic.
 *   - `pauseAt` requires a future target; use an offset past the
 *     install time to survive page.goto jitter.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-reboot-countdown';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test('reboot cancel-pill countdown ticks 00:30 → 00:20 → 00:10 as the clock advances', async ({ page }) => {
  // IMPORTANT: install the fake clock BEFORE navigation. If we install
  // after page load, React's setInterval in MachineStatusPill was
  // already registered against the REAL timer — subsequent
  // `fastForward` won't drive it. The tradeoff: the clock replacement
  // has to coexist with Firebase Auth's onAuthStateChanged timing, so
  // the anchor MUST be close to real "now" (a fixed-past anchor breaks
  // token validation and leaves the dashboard stuck in "buffering…").
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // Seed a machine mid-reboot — rebootScheduledAt = nowSec + 30 via
  // real Date.now() at seed time (seedMachine doesn't share the page's
  // fake clock; it uses the Node-side Admin SDK).
  await seedMachine(SITE_ID, MACHINE_ID, { rebootingInSec: 30 });
  await clearMachineCommands();

  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  const cancelPill = card.getByTestId('machine-status-cancel-pill');
  await expect(cancelPill).toBeVisible();

  // Don't pause — that would jump the fake clock to the pause target
  // and leave the countdown reading 00:00. Instead, rely on the fact
  // that `install` froze the real clock and fastForward is the ONLY
  // way fake time advances from here. The natural ticks during
  // page.goto (at real wall-clock rate) still happen, but from this
  // line forward the clock is effectively paused until we fastForward.

  // Initial read — the countdown should be 00:29 or 00:30 depending on
  // which side of the 1s tick boundary we're on at assertion time.
  // Exact-match is too brittle here given the 500ms install-time offset,
  // so assert the MM:SS pattern + a range via regex. The pill hover-swaps
  // text with "cancel", so assert the countdown span specifically.
  const countdownSpan = cancelPill.locator('span').filter({ hasText: /^\d\d:\d\d$/ });

  // Wide initial tolerance: seed → dashboard-load → install takes a few
  // real-clock seconds; remaining at install time can be anywhere in
  // ~[25, 30]. Capture the initial reading and do relative assertions.
  const initialText = (await countdownSpan.textContent())!;
  const initialSeconds = parseInt(initialText.split(':')[1], 10);
  expect(initialSeconds).toBeGreaterThanOrEqual(25);
  expect(initialSeconds).toBeLessThanOrEqual(30);

  // Advance 10 fake seconds — countdown should drop by exactly 10 (±1
  // for the 1s tick boundary; the pill's setInterval ticks once per
  // second against Date.now()).
  await page.clock.fastForward(10_000);
  const after10Text = (await countdownSpan.textContent())!;
  const after10Seconds = parseInt(after10Text.split(':')[1], 10);
  expect(Math.abs(after10Seconds - (initialSeconds - 10))).toBeLessThanOrEqual(1);

  // Advance another 10s — countdown drops by another ~10.
  await page.clock.fastForward(10_000);
  const after20Text = (await countdownSpan.textContent())!;
  const after20Seconds = parseInt(after20Text.split(':')[1], 10);
  expect(Math.abs(after20Seconds - (initialSeconds - 20))).toBeLessThanOrEqual(1);
});
