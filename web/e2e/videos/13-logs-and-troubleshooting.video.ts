/**
 * Scene — episode 13, "logs & troubleshooting".
 *
 * Every beat in this episode is SCREEN capture (no B-ROLL). Beat list with
 * rendered VO durations (voiceover/out/13-logs-and-troubleshooting/, ffprobe):
 *   b01 the activity timeline       ~19.8s  → /logs page, seeded reverse-chrono list
 *   b02 reading an entry            ~20.3s  → highlight one row + its level badge
 *   b03 filtering the noise         ~24.1s  → show filters → step through dropdowns
 *   b04 the crash screenshot        ~19.5s  → expand the seeded process_crash row, open img
 *   b05 expand for the full record  ~13.3s  → expand-all toggle, highlight machine id + ts
 *   b06 clear up, and where to go next ~43.5s  → clear logs dialog (do NOT confirm)
 *
 * NOTE from the script: control-process-restarting seeds processes but not
 * logs. This scene seeds a small set of log entries inline (info / warning /
 * error mix, one with a crash screenshot) so the timeline reads as populated
 * before the camera lands on /logs. The shape matches the LogEvent interface
 * in web/app/logs/page.tsx (action, level, machineId, machineName,
 * processName, details, screenshotUrl, timestamp).
 *
 * The "crash screenshot" thumbnail is a tiny inline PNG (1x1 transparent) so
 * the row renders the Camera icon + click-to-enlarge interaction without a
 * network fetch.
 *
 * Run:  cd web && npm run videos -- --grep "episode 13"
 * Out:  web/e2e/.output/videos/13-logs-and-troubleshooting.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  highlight,
  clickWithCursor,
  centerInView,
  moveCursorTo,
} from './video-helpers';

// 1x1 transparent PNG as a data URI — lets the crash-screenshot row render
// the Camera indicator + the click-to-enlarge interaction without an external
// fetch (no risk of a broken image icon on camera).
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('episode 13 — logs & troubleshooting', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');
  try {
    // Auto-select the seeded site on load.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Seed a small population of log entries. The agent / web write these with
    // Firestore Timestamps; Date objects are auto-converted by the Admin SDK
    // on write, and Timestamp.toDate() round-trips cleanly on read.
    const now = Date.now();
    const ago = (sec: number): Date => new Date(now - sec * 1000);
    const logsRef = getAdminDb().collection('sites').doc(ctx.siteId).collection('logs');
    const entries = [
      {
        id: 'log-crash-touchdesigner',
        timestamp: ago(60 * 7),
        action: 'process_crash',
        level: 'error',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'touchdesigner.exe',
        details:
          'process exited with code -1073741819 (access violation). cuda driver hiccup on GPU0. auto-restart in 8s.',
        screenshotUrl: TRANSPARENT_PNG,
      },
      {
        id: 'log-restart-touchdesigner',
        timestamp: ago(60 * 6),
        action: 'process_started',
        level: 'info',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'touchdesigner.exe',
        details: 'auto-restart after crash (attempt 1/3). pid 4218.',
      },
      {
        id: 'log-deploy-failed',
        timestamp: ago(60 * 60 * 4),
        action: 'deployment_failed',
        level: 'error',
        machineId: 'media-server-stage',
        machineName: 'media-server-stage',
        processName: '',
        details: 'msi exit code 1603 (fatal install error) — TouchDesigner-2024.40000.exe',
      },
      {
        id: 'log-disk-warning',
        timestamp: ago(60 * 60 * 2),
        action: 'command_executed',
        level: 'warning',
        machineId: 'media-server-stage',
        machineName: 'media-server-stage',
        processName: '',
        details: 'disk C: at 88% capacity — consider clearing render cache.',
      },
      {
        id: 'log-scheduled-reboot',
        timestamp: ago(60 * 60 * 18),
        action: 'scheduled_reboot',
        level: 'info',
        machineId: 'lobby-display',
        machineName: 'lobby-display',
        processName: '',
        details: 'scheduled restart completed (preset: weekday 4am).',
      },
      {
        id: 'log-agent-started-1',
        timestamp: ago(60 * 60 * 20),
        action: 'agent_started',
        level: 'info',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: '',
        details: 'agent online — version 3.0.0.',
      },
      {
        id: 'log-agent-started-2',
        timestamp: ago(60 * 60 * 26),
        action: 'agent_started',
        level: 'info',
        machineId: 'mainstage-led',
        machineName: 'mainstage-led',
        processName: '',
        details: 'agent online — version 3.0.0.',
      },
      {
        id: 'log-obs-killed',
        timestamp: ago(60 * 60 * 30),
        action: 'process_killed',
        level: 'warning',
        machineId: 'td-control-room',
        machineName: 'td-control-room',
        processName: 'obs64.exe',
        details: 'killed by deploy hook (close-processes flag set on stage-show v3).',
      },
    ];
    for (const e of entries) {
      const { id, ...data } = e;
      await logsRef.doc(id).set(data);
    }

    await recordScene(
      browser,
      '13-logs-and-troubleshooting',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] the activity timeline — settle on /logs (~19.8s VO).
        await openForCapture(page, '/logs');
        await expect(
          page.getByRole('heading', { name: 'logs', exact: true }),
        ).toBeVisible();
        // Newest-first crash row should be at the top.
        await expect(
          page.getByText('access violation', { exact: false }).first(),
        ).toBeVisible();
        await narrate(page, 'b01 logs timeline — settle', 20);

        // [b02] reading an entry — frame the crash row + its level badge (~20.3s VO).
        const crashRow = page.getByTestId('log-row-log-crash-touchdesigner');
        await centerInView(page, crashRow);
        await highlight(page, crashRow, 2200);
        await narrate(page, 'b02 row anatomy', 12);
        // Then highlight the deploy-failed row so the "red error" beat lands
        // with two error rows on screen.
        const deployFailedRow = page.getByTestId('log-row-log-deploy-failed');
        await centerInView(page, deployFailedRow);
        await highlight(page, deployFailedRow, 1800);
        await narrate(page, 'b02 second error row', 8);

        // [b03] filtering the noise (~24.1s VO).
        // Open the filters panel, then step through action / machine / level / date.
        const filtersBtn = page.getByRole('button', { name: /show filters/i });
        await clickWithCursor(page, filtersBtn);
        await page.waitForTimeout(400);

        const actionFilter = page.getByTestId('logs-filter-action');
        await highlight(page, actionFilter, 1400);
        await narrate(page, 'b03 action filter', 5);

        const machineFilter = page.getByTestId('logs-filter-machine');
        await highlight(page, machineFilter, 1400);
        await narrate(page, 'b03 machine filter', 4);

        const levelFilter = page.getByTestId('logs-filter-level');
        await highlight(page, levelFilter, 1400);
        await narrate(page, 'b03 level filter', 4);

        const dateFilter = page.getByTestId('logs-filter-date');
        await highlight(page, dateFilter, 1400);
        await narrate(page, 'b03 date filter', 4);

        // Demo the search input — click the collapsed "search" button to expand it.
        // The collapsed-state button's accessible name is "search logs" (aria-label
        // at web/app/logs/page.tsx:866), not just "search" — visible glyph reads
        // "search" but a11y matches the aria-label.
        const searchBtn = page.getByRole('button', { name: /search logs/i });
        await clickWithCursor(page, searchBtn);
        const searchInput = page.getByTestId('logs-search');
        await expect(searchInput).toBeVisible();
        await highlight(page, searchInput, 1800);
        await narrate(page, 'b03 search box', 7);

        // [b04] the crash screenshot (~19.5s VO).
        // Expand the crash row to reveal the inline thumbnail. The row's inner
        // cells (event / details / time) are wrapped in Radix Tooltips that
        // mount on hover and overlay the CollapsibleTrigger — same intercept
        // pattern as ep07's MachineContextMenu. moveCursorTo + force-click past
        // the tooltip portal (shared `clickWithCursor` is off-limits).
        await centerInView(page, crashRow);
        await moveCursorTo(page, crashRow);
        await page.waitForTimeout(250);
        await crashRow.click({ force: true });
        await page.waitForTimeout(400);
        const crashThumb = crashRow.locator('img[alt="Crash screenshot"]');
        await expect(crashThumb).toBeVisible();
        await highlight(page, crashThumb, 2200);
        await narrate(page, 'b04 crash thumbnail', 10);
        // Click it to open the full-size modal.
        await clickWithCursor(page, crashThumb);
        const fullModal = page.locator('img[alt="Crash screenshot"]').last(); // the modal img is appended last
        await expect(fullModal).toBeVisible();
        await narrate(page, 'b04 crash modal open', 9);
        // Dismiss the modal so the next beat lands on the list again.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // [b05] expand for the full record (~13.3s VO).
        // Collapse the already-open crash row first, then hit expand-all.
        // Same tooltip-overlay workaround as the open above.
        await moveCursorTo(page, crashRow);
        await page.waitForTimeout(250);
        await crashRow.click({ force: true });
        await page.waitForTimeout(300);
        const expandAllBtn = page.getByTestId('logs-expand-all');
        await clickWithCursor(page, expandAllBtn);
        await page.waitForTimeout(500);
        // Highlight the freshly-revealed machine id / timestamp block on the top row.
        const expandedDetails = page
          .getByText('machine id', { exact: true })
          .first();
        await centerInView(page, expandedDetails);
        await highlight(page, expandedDetails, 1800);
        await narrate(page, 'b05 expand-all detail block', 13);

        // [b06] clear up, and where to go next (~43.5s VO).
        // Collapse all back before opening the destructive dialog.
        await clickWithCursor(page, expandAllBtn);
        await page.waitForTimeout(300);
        const clearLogsBtn = page.getByRole('button', { name: /^clear logs$/i });
        await centerInView(page, clearLogsBtn);
        await clickWithCursor(page, clearLogsBtn);
        const clearDialog = page.getByRole('dialog', { name: /clear event logs/i });
        await expect(clearDialog).toBeVisible();
        await narrate(page, 'b06 clear dialog open', 20);
        // Highlight the scope copy explaining what gets deleted — sized so the
        // VO's "narrow by machine or level first" landing point hits the right beat.
        const scopeCopy = clearDialog
          .getByText(/with no date range or view filters set/i)
          .first();
        await centerInView(page, scopeCopy);
        await highlight(page, scopeCopy, 2400);
        await narrate(page, 'b06 scope warning', 14);
        // Cancel out — never confirm on camera.
        await clickWithCursor(page, clearDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(clearDialog).not.toBeVisible();
        await narrate(page, 'b06 outro rest', 9);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
