import { test, expect, type Locator } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';

// Guards the button hover standard — hover once went dead on the logs toolbar
// when buttons overrode the shared style with a near-invisible `hover:bg-muted`.
//
// Assert geometry, not colour: with .btn-sweep, hover is a --btn-hover gradient
// scrim animating background-size 0% -> 100% over an unchanged
// background-color, so a backgroundColor assertion would prove nothing. Pinning
// the sweep catches a missing scrim, a transparent --btn-hover, and a dropped
// .btn-sweep alike, without colour literals.
test.describe('button hover states', () => {
  test.use(roleState('admin'));

  const sweep = (loc: Locator) =>
    loc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, size: cs.backgroundSize };
    });

  test('outline toolbar buttons sweep their hover fill in on hover', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

    const buttons = [
      page.getByRole('button', { name: /search logs/i }),
      page.getByRole('button', { name: /show filters/i }),
    ];

    for (const button of buttons) {
      await expect(button).toBeVisible();
      const rest = await sweep(button);

      // at rest: layer present, collapsed to zero width
      expect(rest.image, 'button should carry a hover sweep layer').toContain('gradient');
      expect(rest.image, 'the sweep colour must not be transparent').not.toContain(
        'rgba(0, 0, 0, 0)',
      );
      expect(rest.size, 'sweep should be collapsed at rest').toBe('0% 100%');

      await button.hover();
      await page.waitForTimeout(300); // let the 200ms sweep settle

      const hovered = await sweep(button);
      expect(hovered.size, 'sweep should cover the button on hover').toBe('100% 100%');

      // reset so the next button measures from its true resting state
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    }
  });
});
