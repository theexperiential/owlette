/**
 * Admin — email page (C3.6)
 *
 * The email admin page is READ-ONLY for configuration: provider /
 * from-address / admin-email / env are driven by `RESEND_API_KEY` +
 * `ADMIN_EMAIL_*` env vars, not user-editable. There is no "SMTP save"
 * surface to test. The interactive surface is:
 *   - a template selector (9 templates hardcoded in the page)
 *   - a "send test email" button that POSTs to /api/test-email
 *
 * This spec:
 *   - asserts the config card renders (provider + badges + env +
 *     from/admin emails) — read-through from /api/platform/email/config
 *   - exercises the template selector (chevron-styled native <select>)
 *     and confirms the description text updates
 *   - stubs /api/test-email via Playwright's page.route() to return a
 *     deterministic success payload → asserts toast + success panel
 *     (Template / Sent to / email ID)
 *   - stubs the same route with a failure payload → asserts error
 *     toast + red error panel with details
 *
 * Stubbing (not hitting Resend) keeps the test deterministic and
 * doesn't require a live API key in the emulator env.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('superadmin'));

async function stubTestEmail(page: Page, response: Record<string, unknown>, status = 200) {
  await page.route('**/api/test-email', async (route: Route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

test('config card renders provider + from/admin emails + environment', async ({ page }) => {
  await page.goto('/admin/email');

  // Bumped to 10s because RequireSuperadmin renders a "verifying permissions..."
  // gate while AuthContext hydrates against the auth emulator; the default 5s
  // expect timeout occasionally races that hydration on cold-emulator runs.
  // Subsequent heading-readiness checks in this spec keep the same bump.
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // Config read-through is async — wait for the provider field to populate.
  // "Resend" is inline with the badge inside <dd>, so the <dd>'s full text
  // is "Resend connected" rather than just "Resend" — a plain substring
  // match is what we want here, not `exact: true`.
  await expect(page.getByText('Resend').first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('provider', { exact: true })).toBeVisible();
  await expect(page.getByText('environment', { exact: true })).toBeVisible();
  await expect(page.getByText('from address', { exact: true })).toBeVisible();
  await expect(page.getByText('admin email', { exact: true })).toBeVisible();
});

test('template selector shows all 9 templates and updates the description', async ({ page }) => {
  await page.goto('/admin/email');

  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const select = page.locator('#template-select');
  await expect(select).toBeVisible();

  // Default is "test" — its description lives underneath the select.
  await expect(page.getByText('generic config verification')).toBeVisible();

  // Pick "process crashed" — description updates to its text.
  await select.selectOption('process_crash');
  await expect(page.getByText('monitored process stopped unexpectedly')).toBeVisible();

  // Quick sanity check: all 9 template options are present.
  const optionCount = await select.locator('option').count();
  expect(optionCount).toBe(9);
});

test('clicking "send test email" with a stubbed success response shows the success panel', async ({ page }) => {
  await stubTestEmail(page, {
    success: true,
    to: 'e2e-recipient@example.test',
    emailId: 're_e2e_stubbed_123',
    template: 'test',
  });

  await page.goto('/admin/email');
  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^send test email$/i }).click();

  // Success toast.
  await expect(page.getByText('Test email sent successfully!', { exact: true })).toBeVisible();
  // Success result panel details — scope to main so toast-description
  // duplicates don't trigger strict-mode.
  const main = page.getByRole('main');
  await expect(main.getByText('Email sent successfully', { exact: true })).toBeVisible();
  await expect(main.getByText('e2e-recipient@example.test', { exact: true })).toBeVisible();
  await expect(main.getByText('re_e2e_stubbed_123', { exact: true })).toBeVisible();
});

test('clicking "send test email" with a stubbed failure surfaces the error', async ({ page }) => {
  await stubTestEmail(
    page,
    { success: false, error: 'RESEND_API_KEY missing', details: 'env var unset' },
    500,
  );

  await page.goto('/admin/email');
  // Wait for RequireSuperadmin's spinner to clear (see top-of-file comment).
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^send test email$/i }).click();

  // Error toast.
  await expect(page.getByText('Failed to send test email', { exact: true })).toBeVisible();
  // Error panel + details — scope to main so we don't collide with the
  // toast description, which echoes the same `error` / `details` strings.
  const main = page.getByRole('main');
  await expect(main.getByText('Failed to send email', { exact: true })).toBeVisible();
  await expect(main.getByText('RESEND_API_KEY missing', { exact: true })).toBeVisible();
  await expect(main.getByText(/env var unset/)).toBeVisible();
});
