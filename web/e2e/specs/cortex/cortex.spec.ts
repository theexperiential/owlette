import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  clearCortexFixture,
  seedCortexFixture,
} from '../../helpers/coverageSeed';

test.describe('cortex key guard', () => {
  test.use(roleState('member'));

  test('shows the no-key overlay and account-settings path', async ({ page }) => {
    await clearCortexFixture(TEST_USERS.member.uid);
    await page.goto('/cortex');
    await expect(page.getByText(/cortex requires an LLM API key/i)).toBeVisible();
    await page.getByRole('button', { name: /open account settings/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('cortex conversations and controls', () => {
  test.use(roleState('admin'));

  test.beforeEach(async () => {
    await seedCortexFixture({ userId: TEST_USERS.admin.uid });
  });

  test('loads, searches, renames, and deletes seeded conversations', async ({ page }) => {
    await page.goto('/cortex');
    await expect(page.getByText('Deployment triage')).toBeVisible();
    await expect(page.getByText('Nightly auto investigation')).toBeVisible();

    await page.getByText('Deployment triage').click();
    await expect(page.getByText(/installer exited with a retryable warning/i)).toBeVisible();
    await expect(page.getByText(/checkLogs/i)).toBeVisible();

    await page.getByRole('button', { name: /search conversations/i }).click();
    await page.getByPlaceholder(/search/i).fill('auto');
    await expect(page.getByText('Nightly auto investigation')).toBeVisible();
    await expect(page.getByText('Deployment triage')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByText('Deployment triage').hover();
    await page.getByRole('button', { name: /rename Deployment triage/i }).click();
    await page.locator('input').last().fill('Deployment RCA');
    await page.getByRole('button', { name: /save rename Deployment triage/i }).click();
    await expect(page.getByText('Deployment RCA')).toBeVisible();

    await page.getByText('Deployment RCA').hover();
    await page.getByRole('button', { name: /delete Deployment RCA/i }).click();
    await page.getByRole('button', { name: /confirm delete Deployment RCA/i }).click();
    await expect(page.getByText('Deployment RCA')).toHaveCount(0);
  });

  test('switches between site and machine targets and surfaces offline warnings', async ({ page }) => {
    await page.goto('/cortex');
    await expect(page.getByLabel(/cortex target/i)).toBeVisible();

    await page.getByLabel(/cortex target/i).click();
    await page.getByRole('option', { name: /e2e-cortex-machine/i }).click();
    await expect(page.getByText(/cortex active/i)).toBeVisible();

    await page.getByLabel(/cortex target/i).click();
    await page.getByRole('option', { name: /e2e-cortex-offline/i }).click();
    await expect(page.getByText(/machine is offline/i)).toBeVisible();
  });

  test('shows send error state when the Cortex API rejects a message', async ({ page }) => {
    await page.route('**/api/cortex', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'LLM unavailable in e2e' }),
      });
    });

    await page.goto('/cortex');
    await page.getByPlaceholder(/ask about this machine/i).fill('summarize the latest issue');
    await page.getByRole('button', { name: /send message/i }).click();
    await expect(page.getByText(/LLM unavailable in e2e/i)).toBeVisible();
  });
});
