/**
 * Time-travel — display apply deadline auto-revert UI (E2.1)
 *
 * DisplayLayoutPanel's ack banner is wrapped in an absolute-deadline
 * effect (components/charts/DisplayLayoutPanel.tsx:283-304):
 *   - when apply dispatch succeeds, `ackDeadlineMs = Date.now() + 30_000`.
 *   - a 250ms setInterval checks `Date.now() >= ackDeadlineMs`; on
 *     expiry it clears state AND toasts "no confirmation sent — agent
 *     will auto-revert".
 *
 * This spec drives that deadline via page.clock:
 *   1. Pre-seed assigned layout so restore is enabled.
 *   2. Install clock BEFORE goto (E1.2 lesson) so setInterval is
 *      captured by the fake clock from mount.
 *   3. Dispatch restore → banner appears.
 *   4. fastForward 31s → banner clears + auto-revert toast fires.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-apply-deadline-target';

function monitor(index: number, position: { x: number; y: number }) {
  return {
    id: `MONITOR\\TEST${index}`,
    edidHash: `hash-${MACHINE_ID}-${index}`,
    manufacturerId: 'TST',
    productCode: `000${index}`,
    serialNumber: `SN${index}`,
    friendlyName: `Test Monitor ${index + 1}`,
    position,
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: index === 0,
    connectionType: 'dp',
    adapterLuid: '0:0',
    targetId: index,
  };
}

async function seedAssignedLayout() {
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        remoteApplyEnabled: true,
        assigned: {
          monitors: [monitor(0, { x: 0, y: 0 }), monitor(1, { x: 1920, y: 0 })],
          capturedAt: Timestamp.now(),
          capturedBy: 'admin@e2e.test',
        },
      },
    },
    { merge: true },
  );
}

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test('apply deadline expires without ack — banner clears + auto-revert toast fires', async ({ page }) => {
  const realNow = Date.now();
  // Install clock BEFORE navigation — same rule as E1.2. Anchor = Date.now()
  // so Firebase Auth's timing still resolves and the dashboard doesn't
  // stall on "buffering…".
  await page.clock.install({ time: realNow });

  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await seedAssignedLayout();

  await page.goto('/dashboard');
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  // Dispatch restore — apply_display_topology lands, 30s banner appears.
  await panel.getByTestId('display-recall-button').click();
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restore this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^restore$/i }).click();

  // DisplayLayoutPanel has two role="status" elements: the ack banner
  // and the loading spinner (aria-label="loading displays"). A restore
  // dispatch can re-flip `loading` on the display hook mid-tick, so
  // `getByRole('status')` alone hits a strict-mode violation. Scope to
  // the banner via its distinctive text.
  const banner = panel.getByRole('status').filter({ hasText: /keep this layout/i });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\? auto-revert in \d+s/);

  // Fast-forward past the 30-second deadline. The 250ms tick should fire
  // at least once with `Date.now() >= ackDeadlineMs`, triggering
  // toast.error + state clear.
  await page.clock.fastForward(31_000);

  // Banner clears (role="status" no longer rendered — ackDeadlineMs = null).
  await expect(banner).toHaveCount(0, { timeout: 5_000 });
  // Auto-revert toast — exact wording from DisplayLayoutPanel:294.
  await expect(
    page.getByText('no confirmation sent — agent will auto-revert', { exact: true }),
  ).toBeVisible();
});
