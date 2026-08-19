import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import {
  clearHootFixture,
  seedHootFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

test.use({ reducedMotion: 'reduce' });

async function stabilizeForA11y(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }

      .hero-enter,
      .hero-enter-nav,
      .hero-enter-delay-1,
      .hero-enter-delay-2,
      .hero-enter-delay-3 {
        opacity: 1 !important;
        transform: none !important;
      }
    `,
  });
  await page.evaluate(() => document.fonts?.ready);
}

async function expectNoSeriousA11yViolations(page: Page) {
  await stabilizeForA11y(page);
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
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
        checks: [...node.any, ...node.all, ...node.none].map((check) => ({
          id: check.id,
          message: check.message,
          data: check.data,
        })),
      })),
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

  test('hoot keyed state has no serious/critical axe violations', async ({ page }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');
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

test.describe('member no-key hoot a11y smoke', () => {
  test.use(roleState('member'));

  test('hoot no-key overlay has no serious/critical axe violations', async ({ page }) => {
    await clearHootFixture(TEST_USERS.member.uid);
    await page.goto('/hoot');
    await expect(page.getByText(/hoot requires an LLM API key/i)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
