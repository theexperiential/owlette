import { test, expect } from '@playwright/test';
import {
  deleteDocIfExists,
  seedInstallerLatest,
} from '../../helpers/coverageSeed';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('public routes', () => {
  test('landing page exposes the primary CTAs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /attention is all you need/i })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(page.getByRole('main').getByRole('link', { name: 'sign in', exact: true })).toHaveAttribute('href', '/login');
  });

  test('legal static pages render and cross-link', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: /privacy policy/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /terms of service/i })).toHaveAttribute('href', '/terms');

    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: /terms of service/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /privacy policy/i })).toHaveAttribute('href', '/privacy');
  });

  test('unsubscribe success and failure states render', async ({ page }) => {
    await page.goto('/unsubscribe?success=true');
    await expect(page.getByRole('heading', { name: /unsubscribed/i })).toBeVisible();
    await expect(page.getByText(/no longer receive machine offline alert emails/i)).toBeVisible();

    await page.goto('/unsubscribe');
    await expect(page.getByRole('heading', { name: /^unsubscribe$/i })).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toBeVisible();
  });

  test('DMCA form accepts a complete notice', async ({ page }) => {
    await page.goto('/legal/dmca');
    await expect(page.getByRole('heading', { name: /dmca takedown notice/i })).toBeVisible();

    await page.getByLabel(/\(1\).*copyrighted work/i).fill('E2E copyrighted installation');
    await page.getByLabel(/\(2\).*material/i).fill('https://owlette.test/e2e/material');
    await page.getByLabel(/\(3\).*your name/i).fill('E2E Copyright Owner');
    await page.getByLabel(/^email$/i).fill('owner@example.test');
    await page.getByLabel(/^address$/i).fill('123 E2E Street, Test City, CA 90000');
    await page.getByRole('checkbox').nth(0).click();
    await page.getByRole('checkbox').nth(1).click();
    await page.getByLabel(/\(6\).*electronic signature/i).fill('E2E Copyright Owner');
    await page.getByRole('button', { name: /submit notice/i }).click();

    await expect(page.getByText(/notice received/i)).toBeVisible();
    await expect(page.getByText(/reference id/i)).toBeVisible();
  });

  test('demo route mounts and switches between list and card views', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByRole('heading', { name: /welcome to owlette/i })).toBeVisible();

    await page.getByRole('button', { name: /card view/i }).click();
    await expect(page.getByText(/machines/i).first()).toBeVisible();
    await page.getByRole('button', { name: /list view/i }).click();
    await expect(page.locator('table')).toBeVisible();
  });

  test('API docs route loads the Scalar shell', async ({ page }) => {
    await page.goto('/docs/api');
    await expect(page).toHaveTitle(/Scalar API Reference|owlette API Reference/i);
  });

  test('download permalink redirects to latest installer and falls back when empty', async ({ request }) => {
    await seedInstallerLatest('https://example.test/downloads/owlette-e2e.exe');
    const latest = await request.get('/download', { maxRedirects: 0 });
    expect([307, 308]).toContain(latest.status());
    expect(latest.headers().location).toBe('https://example.test/downloads/owlette-e2e.exe');

    await deleteDocIfExists('installer_metadata/latest');
    const fallback = await request.get('/download', { maxRedirects: 0 });
    expect([307, 308]).toContain(fallback.status());
    expect(fallback.headers().location).toMatch(/\/login$/);
  });
});
