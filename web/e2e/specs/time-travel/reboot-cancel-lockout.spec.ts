/**
 * Time-travel — cancel-lockout final 5s (E1.3)
 *
 * MachineStatusPill gates cancel on `remaining > CANCEL_LOCKOUT_THRESHOLD` (5s,
 * components/MachineStatusPill.tsx:16): under that it swaps the clickable
 * `<button data-testid="machine-status-cancel-pill">` for a text-only Badge with no
 * handler. Worth pinning because `shutdown /a` is unreliable in the last few seconds, and
 * a refactor reintroducing the button would make a late click appear to work but fail.
 *
 * install-before-goto + fastForward pattern from E1.2: anchor the clock at `Date.now()`
 * to survive Firebase Auth timing, don't pauseAt (it skips the countdown ticks), and
 * fastForward into the lockout window deterministically.
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

  // Fast-forward past the 5s threshold. seedMachine wrote rebootScheduledAt = nowSec + 30
  // and the fake clock drifts a couple of seconds before the dashboard renders, so +27s
  // leaves `remaining` around 0-2 — inside the lockout band.
  await page.clock.fastForward(27_000);

  // Cancel testid disappears — the component takes the non-interactive `!canCancel` Badge.
  await expect(cancelPill).toHaveCount(0, { timeout: 5_000 });

  // The status badge renders in its place; its label moved from visible text to the
  // badge's role=img aria-label, so assert on the accessible name, scoped to the card.
  await expect(card.getByRole('img', { name: /^restarting/i })).toBeVisible();
});
