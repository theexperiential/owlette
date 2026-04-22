/**
 * Time-travel — fresh heartbeat renders online pill (E3.1)
 *
 * Baseline state for E3.x's staleness transitions. useMachines' 30s
 * setInterval (`useFirestore.ts:854-880`) re-evaluates `online` as
 * `machine.online === true && heartbeatAge < 180`. With a freshly
 * seeded heartbeat (age ~0s), both conditions hold and the pill
 * renders "online" green.
 *
 * No `page.clock` here — the fresh-heartbeat case doesn't need
 * time-travel; it's the assertion the suite is in a known good
 * baseline before E3.2 (stale) and E3.3 (recovery) flip it.
 * Keeping the fixture shape identical to E3.2/E3.3 means any
 * shared-setup regression surfaces uniformly.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-fresh';

test('fresh heartbeat renders the green online pill', async ({ page }) => {
  // heartbeatOffsetSec=0 (the default) writes lastHeartbeat = nowSec,
  // so heartbeatAge = 0 and the staleness check (<180s) passes
  // trivially. online=true is also set by seedMachine, satisfying
  // the dual-condition gate at useFirestore.ts:869.
  await seedMachine(SITE_ID, MACHINE_ID);

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();

  // MachineStatusPill's idle branch (components/MachineStatusPill.tsx:64-70)
  // renders a Badge whose text is exactly "online" (green) or "offline"
  // (red). Scope to the card so we don't match the header's "N/M online"
  // stats copy elsewhere on the page.
  await expect(card.getByText('online', { exact: true })).toBeVisible();
  await expect(card.getByText('offline', { exact: true })).toHaveCount(0);
});
