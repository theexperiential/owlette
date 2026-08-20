/**
 * Access-control — platform API 403 gates (server-side).
 *
 * Platform/global routes require superadmin via `web/lib/apiAuth.server.ts`,
 * which throws 403 before any handler logic runs, so member and site-admin must
 * see 403 regardless of body or method. Automates the two "server-side gates
 * (network tab)" rows of the permission-model-split smoke checklist.
 *
 * Three endpoints (two GET, one POST) prove the shared gate; more would only
 * re-test the same middleware. The POST body is irrelevant — the gate
 * short-circuits before validation.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const ADMIN_ENDPOINTS = [
  { method: 'GET', path: '/api/platform/system-presets' },
  { method: 'GET', path: '/api/installer' },
  { method: 'POST', path: '/api/installer/upload', body: {} },
] as const;

// `page.evaluate(fetch(...))` rather than Playwright's `request`/`page.request`:
// those use their own APIRequestContext and drop the HttpOnly+Secure `__session`
// cookie `requireSession` needs, returning 401 instead of the expected 403. A
// same-origin fetch inside the page uses the browser's cookie jar.
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

  // Superadmin clears the auth gate and then fails body validation on the empty
  // POST body — the load-bearing assertion is "not 403"; the 400 is incidental.
  test('POST /api/installer/upload passes the auth gate (non-403)', async ({ page }) => {
    const status = await fetchStatus(page, { method: 'POST', path: '/api/installer/upload', body: {} });
    expect(status).not.toBe(403);
  });
});
