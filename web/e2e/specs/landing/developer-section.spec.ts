import { test, expect } from '@playwright/test';

// Public landing-page section — no auth state required. Run unauthenticated so
// the test mirrors what an anonymous visitor sees and isn't sensitive to the
// shared storageState seeded in global-setup.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('developer section (landing)', () => {
  test('#developers anchor scrolls the section into view', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');
    await expect(section).toBeVisible();
    await expect(section).toBeInViewport();
    await expect(
      section.getByRole('heading', { name: /script your fleet/i })
    ).toBeVisible();
  });

  test('three code tabs render and switching swaps the visible code', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');
    const curlTab = section.getByRole('tab', { name: 'curl', exact: true });
    const cliTab = section.getByRole('tab', { name: 'cli', exact: true });
    const tsTab = section.getByRole('tab', { name: 'typescript', exact: true });

    await expect(curlTab).toBeVisible();
    await expect(cliTab).toBeVisible();
    await expect(tsTab).toBeVisible();

    // Default tab is curl — the curl invocation should be on screen.
    await expect(curlTab).toHaveAttribute('aria-selected', 'true');
    const codeBlock = section.locator('pre code');
    await expect(codeBlock).toContainText('curl -X POST');
    await expect(codeBlock).toContainText('Idempotency-Key');

    // Switch to cli — code should swap to the owlette CLI invocation.
    await cliTab.click();
    await expect(cliTab).toHaveAttribute('aria-selected', 'true');
    await expect(codeBlock).toContainText('owlette process restart');
    await expect(codeBlock).not.toContainText('curl -X POST');

    // Switch to typescript — code should swap to the SDK sample. The sample
    // MUST instantiate `Owlette` (not the legacy `Roost` symbol) — this is the
    // load-bearing assertion guarding the rebrand.
    await tsTab.click();
    await expect(tsTab).toHaveAttribute('aria-selected', 'true');
    await expect(codeBlock).toContainText("import { Owlette } from '@owlette/sdk'");
    await expect(codeBlock).toContainText('new Owlette(');
    await expect(codeBlock).not.toContainText('Roost');
    await expect(codeBlock).not.toContainText('owlette process restart');
  });

  test('bottom CTAs link to the API reference and CLI repo', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');

    await expect(
      section.getByRole('link', { name: /read the api reference/i })
    ).toHaveAttribute('href', '/docs/api');

    const cliLink = section.getByRole('link', { name: /install the cli/i });
    await expect(cliLink).toHaveAttribute(
      'href',
      'https://github.com/theexperiential/owlette/tree/main/cli'
    );
    await expect(cliLink).toHaveAttribute('target', '_blank');
    await expect(cliLink).toHaveAttribute('rel', /noopener/);
  });
});
