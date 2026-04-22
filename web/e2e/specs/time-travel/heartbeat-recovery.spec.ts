/**
 * Time-travel — heartbeat recovery flips the pill back online (E3.3)
 *
 * Closes wave E3. The recovery path: a machine was marked offline by
 * `useMachines`' 30s setInterval (heartbeatAge >= 180s), the agent
 * reports in with a fresh heartbeat + online=true, the onSnapshot
 * listener at `useFirestore.ts:911` fires, `setMachines` wholesale
 * replaces the machine object with the fresh data, and the idle
 * branch of `MachineStatusPill` re-renders with the green "online"
 * Badge.
 *
 * Sequence:
 *   1. Install fake clock; seed stale machine (online=true but
 *      heartbeat 200s old) so the interval's first tick will flip it.
 *   2. Load dashboard — the initial render reads `online: true` from
 *      Firestore directly, so the pill starts green (the interval
 *      hasn't fired yet).
 *   3. fastForward 30s → the interval tick sees heartbeatAge=230 and
 *      flips `online: false` locally → pill flips to red "offline".
 *   4. Admin SDK writes a fresh heartbeat (runs in Node — uses real
 *      wall-clock Date.now(), which is ~30s behind the fake clock but
 *      still well within the 180s threshold).
 *   5. Snapshot delivers the update → setMachines replaces the
 *      machine → pill flips back to green "online".
 *
 * Why this assertion matters separately from E3.1/E3.2: the recovery
 * path exercises the snapshot listener OVERWRITING a client-side
 * `online: false` that was set by the staleness-check interval. A
 * regression where the local flip sticks despite Firestore updating
 * would pass E3.1 + E3.2 and fail only here.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-recovery';

test('stale machine recovers to online when the agent writes a fresh heartbeat', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // Seed stale: online=true + heartbeat 200s old. The onSnapshot listener
  // initially renders the pill as "online" directly from `data.online`;
  // the 30s setInterval's first tick will then detect the stale heartbeat
  // (heartbeatAge=200 >= 180) and flip local state to offline.
  await seedMachine(SITE_ID, MACHINE_ID, { heartbeatOffsetSec: 200 });

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();

  // fastForward past one 30s interval tick. The useEffect at
  // useFirestore.ts:854 registers the setInterval once machines.length
  // flips from 0 → N, so we advance AFTER the card is visible to
  // guarantee the timer exists in the fake-clock's queue.
  await page.clock.fastForward(30_000);
  await expect(card.getByText('offline', { exact: true })).toBeVisible();

  // Agent reports in — write online=true + fresh lastHeartbeat. The
  // admin SDK runs in Node, so Date.now() here is the real wall-clock
  // time (untouched by page.clock). From the browser's fake-clock
  // perspective the write lands ~30s in the past — heartbeatAge at the
  // next interval will be ~30s, well under the 180s threshold.
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set(
      {
        online: true,
        lastHeartbeat: Math.floor(Date.now() / 1000),
      },
      { merge: true },
    );

  // Snapshot fires → setMachines replaces the object → pill flips back
  // to green. This assertion proves the local offline-flip from step 3
  // gets overwritten by the snapshot — without the wholesale-replace
  // semantics of setMachines, the pill would stay stuck offline.
  await expect(card.getByText('online', { exact: true })).toBeVisible();
  await expect(card.getByText('offline', { exact: true })).toHaveCount(0);
});
