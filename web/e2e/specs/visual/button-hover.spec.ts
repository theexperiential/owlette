import { test, expect, type Locator } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';

// Guards the button hover standard. Hover once went "dead" on the logs toolbar
// when individual buttons overrode the shared style with a near-invisible
// `hover:bg-muted`; this catches that regression class.
//
// The MECHANISM changed with the .btn-sweep treatment: hover feedback is no
// longer a `background-color` swap but a `background-image` gradient (the
// --btn-hover scrim) that sweeps left-to-right by animating background-size
// from 0% to 100%. The resting background-color deliberately stays put — the
// scrim paints above it — so asserting on backgroundColor would now prove
// nothing.
//
// These assertions are stricter than the colour check they replace: they pin
// the sweep geometry itself, so hover dying (no scrim layer, a transparent
// --btn-hover, or .btn-sweep dropped from the base class) all fail here.
// Theme-agnostic: no colour literals, only presence and geometry.
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

      // A sweep layer must exist at rest, collapsed to zero width...
      expect(rest.image, 'button should carry a hover sweep layer').toContain('gradient');
      expect(rest.image, 'the sweep colour must not be transparent').not.toContain(
        'rgba(0, 0, 0, 0)',
      );
      expect(rest.size, 'sweep should be collapsed at rest').toBe('0% 100%');

      await button.hover();
      await page.waitForTimeout(300); // let the 200ms sweep settle

      // ...and expand to cover the button on hover.
      const hovered = await sweep(button);
      expect(hovered.size, 'sweep should cover the button on hover').toBe('100% 100%');

      // Reset so the next button is measured from its true resting state.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    }
  });
});
