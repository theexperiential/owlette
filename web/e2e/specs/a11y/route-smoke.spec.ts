import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  clearCortexFixture,
  seedCortexFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test.describe('public a11y smoke', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const route of ['/', '/privacy', '/terms', '/legal/dmca', '/unsubscribe?success=true', '/demo']) {
    test(`${route} has no serious/critical axe violations`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('body')).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});

test.describe('authenticated a11y smoke', () => {
  test.use(roleState('admin'));

  test('logs has no serious/critical axe violations', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test('cortex keyed state has no serious/critical axe violations', async ({ page }) => {
    await seedCortexFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/cortex');
    await expect(page.getByPlaceholder(/ask about this machine/i)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('superadmin a11y smoke', () => {
  test.use(roleState('superadmin'));

  test('admin presets has no serious/critical axe violations', async ({ page }) => {
    await seedSystemPreset('e2e-a11y-system-preset', { name: 'E2E A11Y Template' });
    await page.goto('/admin/presets');
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('member no-key cortex a11y smoke', () => {
  test.use(roleState('member'));

  test('cortex no-key overlay has no serious/critical axe violations', async ({ page }) => {
    await clearCortexFixture(TEST_USERS.member.uid);
    await page.goto('/cortex');
    await expect(page.getByText(/cortex requires an LLM API key/i)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
