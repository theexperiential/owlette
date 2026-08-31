/**
 * Scene — episode 15, "display layouts: capture a wall, put it back".
 *
 * Rendered VO (voiceover/out/15-display-layouts/, ffprobe):
 *   b01 19.6s the wall came back wrong · b02 22.2s the display panel
 *   b03 24.3s store the arrangement · b04 25.4s what drift looks like
 *   b05 22.8s turn restore on · b06 20.0s restore + the thirty-second undo
 *   b07 20.5s let it fix itself · b08 26.2s the events tab
 *   b09 28.4s hand it to a rule
 * b01's opening is B-ROLL (a 2×2 wall coming back wrong); this scene supplies
 * the "cut to the dashboard" half of it.
 *
 * Fixture `display-layout-editor` — `mainstage-led` with a four-monitor 2×2
 * profile, `remoteApplyEnabled: true` and `autoRestore.enabled: true`. Beats
 * b04-b07 each need a state the fixture does not ship, so the scene re-seeds
 * between them, and b08's events tab needs a log feed the fixture does not seed
 * at all — written up front, before the recorder starts. Every write below is
 * the same document the product writes; the panel is live over onSnapshot, so no
 * reload is needed.
 *
 * THE ACTION-BAR SLOT is a three-way choice and drives the whole beat order:
 *   auto-restore ON                        → green "auto" chip   (b07)
 *   auto-restore OFF, remote apply OFF     → "enable restore"    (b05)
 *   auto-restore OFF, remote apply ON      → "restore"           (b06)
 * So b05 runs against BOTH flags false, and its "enable restore" click is what
 * leaves the state b06 needs. The header auto-restore switch cannot be used to
 * turn it off on camera — it is disabled while remote apply is off.
 *
 * NO AGENT IN THE EMULATOR. "test" and "restore" dispatch real commands to a
 * machine that will never answer: the test result banner may resolve to a
 * failure, and the restore ack never arrives. Neither is asserted. The ack
 * banner does appear — its countdown is started client-side right after the
 * dispatch write lands — and the harness's frozen clock holds it at 30s for the
 * whole beat rather than ticking, which is the friendlier frame anyway.
 *
 * Run:  cd web && npm run videos -- --grep "episode 15"
 * Out:  dev/video-tutorials/footage/web/15-display-layouts.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures, FIXED_NOW_MS } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  highlight,
  centerInView,
  clickWithCursor,
} from './video-helpers';

// 211s of narration alone, plus the re-seeds between beats, context creation and
// recorder start — well past the config's 5-minute per-test default.
test.setTimeout(8 * 60_000);

test('episode 15 — display layouts: capture a wall, put it back', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('display-layout-editor');
  const machineId = ctx.machineId!;
  try {
    const db = getAdminDb();
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    const machineRef = db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machineId);
    const configRef = db
      .collection('config')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machineId);

    // b08's events tab reads `sites/{siteId}/logs` through `useDisplayEventFeed`
    // and renders the `display-events-table` ONLY when that query returns rows —
    // an empty feed paints "no display events yet" instead
    // (DisplayLayoutPanel.tsx:787-800). The fixture seeds none, so the tab is
    // empty without this block. Seeded the way episode 16 seeds `/logs`: Admin
    // SDK Date → Timestamp, anchored on FIXED_NOW_MS because `recordScene`
    // freezes the page's clock to it (wall-clock stamps would render months in
    // the page's future).
    //
    // Actions, levels and `details` shapes are the ones the agent really writes,
    // so the frame is not a fiction:
    //   - `_emit_display_event` (owlette_service.py:4809-4840) JSON-serializes
    //     its payload into `details`, which is what `parseEventDetails` reads
    //     for the monitor and drift columns;
    //   - display_manager's `_emit_audit` (display_manager.py:2307-2337) passes a
    //     PLAIN STRING for apply-failed / auto-revert, so those two rows render
    //     em-dashes in monitor + details. That is the product, not a gap here.
    // Together they cover the five the narration names: added, removed, drift,
    // apply failed, auto-reverted.
    const eventAgo = (sec: number): Date => new Date(FIXED_NOW_MS - sec * 1000);
    const logsRef = db.collection('sites').doc(ctx.siteId).collection('logs');
    const displayEvents = [
      {
        id: 'log-display-monitor-added',
        timestamp: eventAgo(60 * 60 * 26),
        action: 'display_monitor_added',
        level: 'info',
        details: JSON.stringify({
          monitorCount: 4,
          monitor: { edidHash: `hash-${machineId}-3`, friendlyName: 'Mainstage 4', port: 'dp' },
        }),
      },
      {
        id: 'log-display-monitor-removed',
        timestamp: eventAgo(60 * 60 * 20),
        action: 'display_monitor_removed',
        level: 'critical',
        details: JSON.stringify({
          monitorCount: 3,
          monitor: { edidHash: `hash-${machineId}-2`, friendlyName: 'Mainstage 3', port: 'dp' },
        }),
      },
      {
        id: 'log-display-apply-failed',
        timestamp: eventAgo(60 * 60 * 12),
        action: 'display_apply_failed',
        level: 'warning',
        details: 'display helper exited 1 — target mode not supported',
      },
      {
        id: 'log-display-auto-reverted',
        timestamp: eventAgo(60 * 60 * 11),
        action: 'display_auto_revert_fired',
        level: 'error',
        details: 'no ack received within 45s; auto-reverted',
      },
      {
        id: 'log-display-drift-mainstage',
        timestamp: eventAgo(60 * 40),
        action: 'display_drift',
        level: 'warning',
        details: JSON.stringify({
          monitorCount: 4,
          monitor: { edidHash: `hash-${machineId}-1`, friendlyName: 'Mainstage 2', port: 'dp' },
          changes: ['position.x', 'position.y'],
        }),
      },
    ];
    for (const e of displayEvents) {
      const { id, ...data } = e;
      await logsRef.doc(id).set({ ...data, machineId, machineName: machineId });
    }

    await recordScene(
      browser,
      '15-display-layouts',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] the wall came back wrong (~19.6s) — the B-ROLL cuts to here.
        await openForCapture(page, '/dashboard');
        const wallCard = page
          .getByTestId('machine-card')
          .filter({ hasText: machineId });
        await expect(wallCard).toBeVisible();
        await centerInView(page, wallCard);
        await highlight(page, wallCard, 2600);
        await narrate(page, 'b01 cut from the wall to the dashboard', 20);

        // [b02] the display panel (~22.2s). The small monitor button in the card
        // header (tooltip "view displays") opens on the `live` tab: the canvas
        // with four rects beside the monitor table.
        const displayButton = wallCard.getByTestId('open-display-panel');
        await highlight(page, displayButton, 2000);
        await clickWithCursor(page, displayButton);
        const panel = page.getByTestId('display-layout-panel');
        await expect(panel).toBeVisible();
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b02 the live tab — canvas + monitor table', 15);
        // The same panel opens from the machine ⋮ → "view displays" — worth a
        // second of b-roll, framed here rather than clicked.
        await highlight(page, panel.getByRole('button', { name: 'live' }), 2200);
        await narrate(page, 'b02 anyone can look; changing is admin work', 8);

        // [b03] store the arrangement (~24.3s).
        await clickWithCursor(page, panel.getByTestId('display-store-button'));
        const storeDialog = page.getByRole('dialog', { name: /store current arrangement/i });
        await expect(storeDialog).toBeVisible();
        await narrate(page, 'b03 store current arrangement?', 7);
        await clickWithCursor(page, storeDialog.getByRole('button', { name: 'store', exact: true }));
        await expect(storeDialog).not.toBeVisible();
        // The stored tab is labelled "stored" but its internal id is `assigned`.
        await clickWithCursor(page, panel.getByRole('button', { name: 'stored' }));
        await clickWithCursor(page, panel.getByTestId('display-edit-button'));
        await narrate(page, 'b03 edit mode — drag on the canvas', 8);
        // Per-monitor editor: the canvas rects are <g role="button"> keyed by
        // friendly name, and a double-click opens the dialog. The DRAG itself is
        // left to a manual pass — a pointer-drag over an SVG group produces a
        // jerky take next to the rest of the cursor work, and the per-monitor
        // dialog carries the same fields the narration lists.
        await panel.getByRole('button', { name: 'Mainstage 2' }).dblclick();
        const monitorEditor = page.getByRole('dialog');
        await expect(monitorEditor).toBeVisible();
        await narrate(page, 'b03 resolution, refresh, rotation, scale, primary', 9);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        await clickWithCursor(page, panel.getByTestId('display-discard-button'));

        // [b04] what drift looks like (~25.4s). The fixture ships live matching
        // stored, so nothing drifts as-shipped — move one monitor in the LIVE
        // profile (hardware/display) and stamp the drift count the card's dot
        // reads.
        const driftedMonitors = [
          { x: 0, y: 0, primary: true },
          { x: 3840, y: 0, primary: false },
          { x: 0, y: 1080, primary: false },
          { x: 1920, y: 1080, primary: false },
        ].map((p, i) => ({
          id: `MONITOR\\MAIN${i}`,
          edidHash: `hash-${machineId}-${i}`,
          manufacturerId: 'SAM',
          productCode: `0E0${i}`,
          serialNumber: `SN-${machineId}-${i}`,
          friendlyName: `Mainstage ${i + 1}`,
          position: { x: p.x, y: p.y },
          resolution: { width: 1920, height: 1080 },
          refreshHz: 60,
          rotation: 0,
          scalePct: 100,
          primary: p.primary,
          connectionType: 'dp',
          adapterLuid: '0:1',
          targetId: i,
        }));
        await machineRef.collection('hardware').doc('display').set(
          {
            schemaVersion: 1,
            signatureHash: `sig-${machineId}-drifted`,
            capturedAt: FIXED_NOW_MS,
            monitors: driftedMonitors,
            mosaicActive: false,
          },
        );
        await machineRef.set(
          { metrics: { schemaVersion: 2, displayDriftCount: 1 } },
          { merge: true },
        );
        await page.waitForTimeout(1200);
        // The tab's accessible name gains ", N display changes from stored"
        // once drift lands, which is also the badge on screen.
        await highlight(page, panel.getByRole('button', { name: /^stored/ }), 2600);
        await narrate(page, 'b04 the stored tab picks up its amber badge', 13);
        await centerInView(page, panel);
        await narrate(page, 'b04 identity includes the port it is plugged into', 12);

        // [b05] turn restore on (~22.8s). Both flags off so the "test" and
        // "enable restore" buttons render — with auto-restore left on, the green
        // "auto" chip occupies that slot and hides them.
        await configRef.set(
          {
            displays: {
              remoteApplyEnabled: false,
              autoRestore: { enabled: false },
            },
          },
          { merge: true },
        );
        await page.waitForTimeout(1200);
        const testButton = panel.getByTestId('display-test-apply-button');
        await expect(testButton).toBeVisible();
        await highlight(page, testButton, 2400);
        await clickWithCursor(page, testButton);
        // The self-test dispatches to an agent that is not there; the inline
        // result banner is framed, never asserted.
        await narrate(page, 'b05 test — read-only, moves nothing', 12);
        const enableRestore = panel.getByTestId('display-enable-remote-apply-button');
        await expect(enableRestore).toBeVisible();
        await clickWithCursor(page, enableRestore);
        const enableDialog = page.getByRole('dialog');
        await expect(enableDialog).toBeVisible();
        await narrate(page, 'b05 enable restore', 6);
        await clickWithCursor(
          page,
          enableDialog.getByRole('button', { name: 'enable restore', exact: true }),
        );
        await page.waitForTimeout(800);
        await narrate(page, 'b05 the switch an admin needs to move monitors', 5);

        // [b06] restore, and the thirty-second undo (~20.0s). Auto-restore stays
        // OFF through this whole beat — "restore" is the third branch of the
        // same slot and only renders while auto-restore is off and remote apply
        // is on, which is exactly what b05 just left behind.
        const restoreButton = panel.getByTestId('display-recall-button');
        await expect(restoreButton).toBeVisible();
        await clickWithCursor(page, restoreButton);
        const restoreDialog = page.getByRole('dialog');
        await expect(restoreDialog).toBeVisible();
        await narrate(page, 'b06 monitors will rearrange in a few seconds', 7);
        await clickWithCursor(
          page,
          restoreDialog.getByRole('button', { name: 'restore', exact: true }),
        );
        // The ack countdown is started client-side the moment the dispatch write
        // resolves, so the banner appears with no agent involved.
        const ackBanner = page.getByText('keep this layout?', { exact: false });
        await expect(ackBanner).toBeVisible({ timeout: 15_000 });
        await centerInView(page, ackBanner);
        await highlight(page, ackBanner, 2600);
        await narrate(page, 'b06 keep, or it puts itself back', 13);

        // [b07] let it fix itself (~20.5s). The header switch is live now that a
        // layout is stored AND restore is enabled, so it can finally be flipped
        // on camera; the slot that held "restore" becomes the green "auto" chip.
        const autoRestoreToggle = panel.getByTestId('display-auto-restore-toggle');
        await centerInView(page, autoRestoreToggle);
        await clickWithCursor(page, autoRestoreToggle);
        await expect(panel.getByTestId('display-auto-restore-status')).toBeVisible({
          timeout: 15_000,
        });
        await narrate(page, 'b07 auto — waits for the change to hold', 10);
        // Trip the breaker for the red banner. Same document the agent writes.
        await configRef.set(
          {
            displays: {
              autoRestore: {
                enabled: true,
                circuitBreaker: {
                  tripped: true,
                  failures: 3,
                  trippedAt: FIXED_NOW_MS - 60 * 1000,
                  lastFailureAt: FIXED_NOW_MS - 60 * 1000,
                  lastError: 'display helper exited 1 — target mode not supported',
                },
              },
            },
          },
          { merge: true },
        );
        await page.waitForTimeout(1200);
        const breakerBanner = panel.getByTestId('display-auto-restore-breaker-banner');
        await expect(breakerBanner).toBeVisible();
        await centerInView(page, breakerBanner);
        await highlight(page, breakerBanner, 2600);
        await narrate(page, 'b07 three failures, then it stops and waits', 11);
        await clickWithCursor(page, panel.getByTestId('display-auto-restore-reset-button'));
        await page.waitForTimeout(600);

        // [b08] the events tab (~26.2s).
        await clickWithCursor(page, panel.getByRole('button', { name: 'events' }));
        await expect(panel.getByTestId('display-events-table')).toBeVisible();
        await narrate(page, 'b08 added, removed, drift, apply failed, auto-reverted', 14);
        await openForCapture(page, '/dashboard');
        await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
        await clickWithCursor(page, page.getByRole('menuitem', { name: /account settings/i }));
        const settingsDialog = page.getByRole('dialog').filter({
          has: page.getByRole('button', { name: /^alerts$/i }),
        });
        await expect(settingsDialog).toBeVisible();
        await clickWithCursor(page, settingsDialog.getByRole('button', { name: /^alerts$/i }).first());
        const displayEventsToggle = settingsDialog.getByText('display events', { exact: false });
        await centerInView(page, displayEventsToggle);
        await highlight(page, displayEventsToggle, 2600);
        await narrate(page, 'b08 display events in your alert settings', 13);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // [b09] hand it to a rule (~28.4s). The talons editor's event trigger
        // carries the display events, "then wait" holds for things to settle,
        // and the visual check is the sentence the wall is judged against.
        await openForCapture(page, '/talons');
        await clickWithCursor(page, page.getByTestId('talon-create'));
        const talonEditor = page.getByTestId('talon-editor');
        await expect(talonEditor).toBeVisible();
        await clickWithCursor(page, talonEditor.getByTestId('trigger-type'));
        await clickWithCursor(page, page.getByRole('option', { name: 'when an event happens' }));
        const eventList = talonEditor.getByTestId('trigger-event');
        await expect(eventList).toBeVisible();
        for (const eventType of ['display_drift', 'display_monitor_removed']) {
          await clickWithCursor(
            page,
            eventList
              .locator('label')
              .filter({ hasText: new RegExp(`^${eventType}$`) })
              .getByRole('checkbox'),
          );
        }
        await highlight(page, talonEditor.locator('#talon-trigger-delay'), 2200);
        await narrate(page, 'b09 display events + then wait', 10);
        await clickWithCursor(
          page,
          talonEditor.getByTestId('condition-type').getByRole('radio', { name: 'visual check' }),
        );
        await highlight(page, talonEditor.locator('#talon-condition-expectation'), 2600);
        await narrate(page, 'b09 the wall watches itself', 9);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);

        // Close on the logs page filtered to the `displays` action group.
        await openForCapture(page, '/logs');
        await clickWithCursor(page, page.getByRole('button', { name: /show filters/i }));
        await highlight(page, page.getByTestId('logs-filter-action'), 2400);
        await narrate(page, 'b09 hand-off to logs', 9);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
