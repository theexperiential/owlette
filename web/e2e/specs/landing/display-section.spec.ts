/**
 * Landing — display section. The negative assertion is the point: copy must
 * never claim owlette APPLIES mosaic topologies. We only detect and protect them.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const DISPLAY_HEADLINE = 'displays that stay put.';

test.describe('landing — display section', () => {
  test('renders headline, three storyboard frames, and api reference link', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: DISPLAY_HEADLINE }),
    ).toBeVisible();

    // One <figure> per storyboard frame.
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: DISPLAY_HEADLINE }),
    });
    await expect(section.locator('figure')).toHaveCount(3);

    // "mosaic-aware", never "applies mosaic".
    const body = await section.innerText();
    expect(body).toContain('mosaic-aware');
    expect(body).not.toContain('applies mosaic');

    // /docs/api root, not a #display-layout anchor — anchors don't resolve in
    // the scalar-rendered reference.
    await expect(
      section.getByRole('link', { name: 'read the display api reference' }),
    ).toHaveAttribute('href', '/docs/api');
  });
});
