/**
 * Time-travel — stale heartbeat flips pill to offline (E3.2)
 *
 * Inverse of E3.1. useMachines has a 30s setInterval at
 * `hooks/useFirestore.ts:854-885` that re-evaluates each machine's
 * `online` flag as
 * `machine.online === true && heartbeatAge < OFFLINE_HEARTBEAT_AGE_SEC`
 * (300s — matched to the cron health-check's OFFLINE_THRESHOLD_MS).
 * Once the heartbeat is older than 300 seconds, the next tick flips
 * `online` to false locally and the MachineStatusPill idle branch
 * re-renders with the red "offline" Badge.
 *
 * Drive the clock forward past the 300s threshold via page.clock.
 * Lessons from E1.2 / E2.1 reused:
 *   - Install clock BEFORE goto so the 30s setInterval is captured by
 *     the fake timer from registration.
 *   - Anchor = real `Date.now()`; a fixed-past anchor breaks Firebase
 *     Auth's onAuthStateChanged timing and the dashboard stalls in
 *     "buffering…".
 *   - No pauseAt — fastForward is sufficient and pauseAt would jump
 *     the clock past multiple interval iterations in one step.
 *
 * Timing: fastForward 330s advances past the 300s staleness threshold
 * AND fires the 30s interval ~11 times, guaranteeing at least one tick
 * sees heartbeatAge >= 300 and updates state.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-stale';

test('heartbeat age exceeding 300s flips the machine pill to offline', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // Fresh heartbeat — heartbeatOffsetSec defaults to 0, so lastHeartbeat
  // is written at real "now". The fake-clock anchor matches real "now",
  // so heartbeatAge starts at ~0 and the baseline pill is "online".
  await seedMachine(SITE_ID, MACHINE_ID);

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await expect(card.getByText('online', { exact: true })).toBeVisible();

  // Advance past the 300s staleness threshold. 330s = past threshold +
  // eleven 30s interval ticks — the tick that lands at heartbeatAge >= 300
  // flips `online` to false via the setMachines updater.
  await page.clock.fastForward(330_000);

  await expect(card.getByText('offline', { exact: true })).toBeVisible();
  await expect(card.getByText('online', { exact: true })).toHaveCount(0);
});
