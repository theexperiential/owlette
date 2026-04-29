/**
 * Landing — display section regression spec.
 *
 * The headline + body copy here is load-bearing brand promise. The negative
 * assertion below (body does NOT contain "applies mosaic") is the safety
 * check: marketing copy must never overpromise that owlette applies mosaic
 * topologies. We only detect/protect them.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — display section', () => {
  test('renders headline, three storyboard frames, and api reference link', async ({ page }) => {
    await page.goto('/');

    // Headline
    await expect(
      page.getByRole('heading', { name: 'change the wall without stranding the room.' }),
    ).toBeVisible();

    // Three storyboard frame containers (one <figure> per frame)
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'change the wall without stranding the room.' }),
    });
    await expect(section.locator('figure')).toHaveCount(3);

    // Body copy contains "mosaic-aware" — and crucially does NOT regress to
    // "applies mosaic". If marketing copy ever changes to claim owlette
    // applies mosaic configurations, this assertion fails.
    const body = await section.innerText();
    expect(body).toContain('mosaic-aware');
    expect(body).not.toContain('applies mosaic');

    // Footer link to the display api reference
    await expect(
      section.getByRole('link', { name: 'read the display api reference' }),
    ).toHaveAttribute('href', '/docs/api#display-layout');
  });
});
