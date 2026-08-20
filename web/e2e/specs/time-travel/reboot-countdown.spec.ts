/**
 * Time-travel — reboot countdown tick.
 *
 * MachineStatusPill renders MM:SS from `Math.max(0, rebootScheduledAt - now)`,
 * with `now` driven by a `setInterval(1000)` over `Date.now() / 1000`
 * (components/MachineStatusPill.tsx:49). This spec drives `page.clock` and
 * asserts the text follows.
 *
 * The anchor is aligned to REAL now: `rebootScheduledAt` is seeded with real
 * Date.now(), so a fixed-past anchor would make the countdown read "months".
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
  // Install the fake clock BEFORE navigation: installed after load, React's
  // setInterval in MachineStatusPill is already bound to the real timer and
  // fastForward won't drive it. The clock also has to coexist with Firebase
  // Auth's onAuthStateChanged, so the anchor must be near real "now" — a
  // fixed-past anchor breaks token validation and hangs on "buffering…".
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // rebootScheduledAt = nowSec + 30 using REAL Date.now(): seedMachine runs
  // Node-side against the Admin SDK and doesn't see the page's fake clock.
  await seedMachine(SITE_ID, MACHINE_ID, { rebootingInSec: 30 });
  await clearMachineCommands();

  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  const cancelPill = card.getByTestId('machine-status-cancel-pill');
  await expect(cancelPill).toBeVisible();

  // Don't pause: pausing jumps the fake clock to the pause target and the
  // countdown reads 00:00. `install` already froze real time, so fastForward is
  // the only way fake time advances from here.

  // Assert the countdown span specifically — the pill hover-swaps its text for
  // "cancel".
  const countdownSpan = cancelPill.locator('span').filter({ hasText: /^\d\d:\d\d$/ });

  // Wide initial tolerance: seed → load → install burns a few real seconds, so
  // remaining lands anywhere in ~[25, 30]. Assert relative to the first read.
  const initialText = (await countdownSpan.textContent())!;
  const initialSeconds = parseInt(initialText.split(':')[1], 10);
  expect(initialSeconds).toBeGreaterThanOrEqual(25);
  expect(initialSeconds).toBeLessThanOrEqual(30);

  // 10 fake seconds → countdown drops by 10 (±1 for the tick boundary).
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
