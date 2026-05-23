import { test, expect, type Locator } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';

// Guards the button hover standard: outline buttons must visibly change their
// background on hover (the base shadcn `hover:bg-accent`). Hover went "dead" on
// the logs toolbar when individual buttons overrode it with the near-invisible
// `hover:bg-muted` — this catches that regression class. The assertion is
// theme-agnostic: it only requires that hover changes the background, which
// holds in both the light and dark token sets.
test.describe('button hover states', () => {
  test.use(roleState('admin'));

  const bgColor = (loc: Locator) =>
    loc.evaluate((el) => getComputedStyle(el).backgroundColor);

  test('outline toolbar buttons change background on hover', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

    const buttons = [
      page.getByRole('button', { name: /search logs/i }),
      page.getByRole('button', { name: /show filters/i }),
    ];

    for (const button of buttons) {
      await expect(button).toBeVisible();
      const rest = await bgColor(button);

      await button.hover();
      await page.waitForTimeout(250); // let the hover transition settle

      const hovered = await bgColor(button);
      expect(hovered, 'hover background should differ from the resting state').not.toBe(rest);
      expect(hovered, 'hover background should not be transparent').not.toBe('rgba(0, 0, 0, 0)');

      // Reset so the next button is measured from its true resting state.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
    }
  });
});
