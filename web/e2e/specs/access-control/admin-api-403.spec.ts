/**
 * Access-control — platform API 403 gates (server-side).
 *
 * Platform/global API routes require a superadmin role through the shared
 * `web/lib/apiAuth.server.ts`, which throws 403 "Forbidden: Superadmin
 * access required" for any authenticated user whose role isn't
 * `superadmin`. Member + site-admin must see 403 regardless of body,
 * method, or whether the endpoint exists semantically — the gate runs
 * before any handler logic.
 *
 * This spec automates the two "server-side gates (network tab)" rows in
 * the permission-model-split manual-smoke-checklist (closing the last
 * avoidable Playwright gap flagged in B4.1's coverage audit).
 *
 * Endpoint selection:
 *   - GET /api/platform/system-presets   → global template library
 *   - GET /api/installer                 → list installer versions
 *   - POST /api/installer/upload         → upload dialog (smoke-checklist row 2;
 *                                          body is irrelevant — the auth gate
 *                                          short-circuits before validation)
 *
 * Three endpoints is enough to prove the shared gate works for both GET
 * and POST. Adding more endpoints would mostly re-test the same middleware.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const ADMIN_ENDPOINTS = [
  { method: 'GET', path: '/api/platform/system-presets' },
  { method: 'GET', path: '/api/installer' },
  { method: 'POST', path: '/api/installer/upload', body: {} },
] as const;

// We call through `page.evaluate(fetch(...))` instead of Playwright's
// `request` or `page.request` because those sit on their own
// APIRequestContext and drop the HttpOnly+Secure `__session` iron-session
// cookie that `requireSession` needs — every attempt via those paths
// returned 401 instead of the expected 403. A same-origin `fetch()` inside
// the page's JS context uses the browser's cookie jar directly, so the
// signed session cookie rides along unchanged.
async function fetchStatus(
  page: Page,
  ep: (typeof ADMIN_ENDPOINTS)[number],
): Promise<number> {
  await page.goto('/login');
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return r.status;
  }, { method: ep.method, path: ep.path, body: 'body' in ep ? ep.body : undefined });
}

test.describe('admin API 403 — member (site-A)', () => {
  test.use(roleState('member'));

  for (const ep of ADMIN_ENDPOINTS) {
    test(`${ep.method} ${ep.path} returns 403`, async ({ page }) => {
      const status = await fetchStatus(page, ep);
      expect(status).toBe(403);
    });
  }
});

test.describe('admin API 403 — admin (site-A)', () => {
  test.use(roleState('admin'));

  for (const ep of ADMIN_ENDPOINTS) {
    test(`${ep.method} ${ep.path} returns 403`, async ({ page }) => {
      const status = await fetchStatus(page, ep);
      expect(status).toBe(403);
    });
  }
});

test.describe('admin API 403 — superadmin', () => {
  test.use(roleState('superadmin'));

  test('GET /api/platform/system-presets returns 200', async ({ page }) => {
    const status = await fetchStatus(page, { method: 'GET', path: '/api/platform/system-presets' });
    expect(status).toBe(200);
  });

  test('GET /api/installer returns 200', async ({ page }) => {
    const status = await fetchStatus(page, { method: 'GET', path: '/api/installer' });
    expect(status).toBe(200);
  });

  // For the POST upload endpoint with an empty body, superadmin gets past the
  // auth gate and then fails body validation — that's 400, not 403. The
  // load-bearing assertion is "not 403" (i.e. the auth gate doesn't block
  // superadmin); the 400 is incidental to sending an empty body.
  test('POST /api/installer/upload passes the auth gate (non-403)', async ({ page }) => {
    const status = await fetchStatus(page, { method: 'POST', path: '/api/installer/upload', body: {} });
    expect(status).not.toBe(403);
  });
});
