/**
 * Time-travel — cancel-lockout final 5s (E1.3)
 *
 * MachineStatusPill's cancel affordance is gated on
 * `remaining > CANCEL_LOCKOUT_THRESHOLD` (= 5 seconds —
 * components/MachineStatusPill.tsx:16). Once the countdown hits 5s,
 * the component swaps the clickable `<button data-testid="machine-status-cancel-pill">`
 * for a text-only `<Badge>{actionLabel}…</Badge>` with no click handler.
 *
 * The underlying rationale (file comment: "Windows shutdown /a is
 * unreliable in the last few seconds") makes this a safety rail worth
 * pinning. A regression could easily reintroduce the clickable button
 * via a refactor, and without this test a user's click in the final
 * seconds would appear to "work" but silently fail.
 *
 * Uses the install-before-goto + fastForward pattern from E1.2:
 *   - install with `Date.now()` anchor to survive Firebase Auth timing
 *   - DON'T pauseAt — it jumps the clock and skips the countdown ticks
 *   - fastForward gets us into the lockout window deterministically
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-reboot-lockout';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test('cancel-pill disappears in the final 5 seconds — only text badge remains', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // Seed with 30s remaining so we start well above the 5s threshold.
  await seedMachine(SITE_ID, MACHINE_ID, { rebootingInSec: 30 });
  await clearMachineCommands();

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  const cancelPill = card.getByTestId('machine-status-cancel-pill');
  await expect(cancelPill).toBeVisible();

  // Pre-lockout: the cancel button IS present and clickable.
  await expect(cancelPill).toBeEnabled();

  // Fast-forward past the 5s threshold. seedMachine wrote
  // rebootScheduledAt = nowSec + 30. We install the clock at realNow,
  // and by the time the dashboard has rendered the fake clock has
  // drifted a couple seconds. fastForwarding 27 seconds should leave
  // `remaining` at roughly 0-2 — inside the lockout band.
  await page.clock.fastForward(27_000);

  // Cancel button testid disappears — component returns the non-interactive
  // Badge branch (`if (!canCancel)`).
  await expect(cancelPill).toHaveCount(0, { timeout: 5_000 });

  // The non-interactive status badge renders in its place: a compact icon +
  // countdown whose accessible name carries the action ("restarting, MM:SS
  // remaining"). The label moved from visible text to the badge's role=img
  // aria-label, so assert on the accessible name. Scope to the machine card.
  await expect(card.getByRole('img', { name: /^restarting/i })).toBeVisible();
});
