/**
 * Dispatch — rollback to manifest (D5.2, PARTIAL)
 *
 * **Scope note**: the backing `/api/roosts/{roostId}/rollback` route
 * is a STUB gated on roost wave 2a.6 — it validates auth, superadmin
 * role, roost id, body shape, and site scope, but the firestore CAS
 * transaction that swaps `currentManifestId` hasn't been implemented
 * yet (returns 501, per `route.ts:67`).
 *
 * Until that wave lands, the "manifest currentId updated" assertion
 * from the plan can't be exercised end-to-end. This spec pins what IS
 * implemented — the auth + validation layers — so the route doesn't
 * silently regress while we wait.
 *
 * Role contract clarification discovered in iter 1: `requireAdminOrIdToken`
 * in `lib/apiAuth.server.ts:84` is a misnomer — it actually requires
 * `role === 'superadmin'` (line 103). Admin + member both 403 before
 * any site-scope check even runs. The roost admin endpoints are therefore
 * superadmin-only, matching the permission-model-split's platform-admin
 * carve-out for cross-cutting ops.
 *
 * Uses the `page.evaluate(fetch)` pattern from B3.4 to preserve the
 * HttpOnly `__session` cookie Playwright's request context would
 * otherwise strip.
 *
 * When wave 2a.6 lands: flip the superadmin happy-path case from "501"
 * to "200 + Admin SDK confirms currentManifestId swapped", and add a
 * `[ ]` follow-up for end-to-end rollback.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';

const SITE_ID = 'site-A';
const ROOST_ID = 'e2e-roost-folder';
const TARGET_MANIFEST_ID = 'manifest-target-abc';

async function rollbackStatus(page: Page, body: Record<string, unknown>): Promise<number> {
  await page.goto('/login');
  return page.evaluate(
    async ({ roostId, body }) => {
      const r = await fetch(`/api/roosts/${roostId}/rollback`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.status;
    },
    { roostId: ROOST_ID, body },
  );
}

test.describe('rollback API — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('POST without a session returns 401', async ({ page }) => {
    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: TARGET_MANIFEST_ID,
    });
    expect(status).toBe(401);
  });
});

test.describe('rollback API — member (non-superadmin)', () => {
  test.use(roleState('member'));

  test('member is rejected at the superadmin gate (403)', async ({ page }) => {
    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: TARGET_MANIFEST_ID,
    });
    expect(status).toBe(403);
  });
});

test.describe('rollback API — admin (site-scoped, NOT platform)', () => {
  test.use(roleState('admin'));

  test('site-admin is rejected at the superadmin gate (403) — roost ops are platform-level', async ({ page }) => {
    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: TARGET_MANIFEST_ID,
    });
    expect(status).toBe(403);
  });
});

test.describe('rollback API — superadmin', () => {
  test.use(roleState('superadmin'));

  test('invalid targetManifestId (non-string) returns 400', async ({ page }) => {
    // Body-validation path: targetManifestId must be a string or omitted.
    // A number hits problemValidation at route.ts:51.
    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: 12345,
    });
    expect(status).toBe(400);
  });

  test('valid body lands on the not-implemented stub (503)', async ({ page }) => {
    // Full path through auth + role gate + body validation + site scope.
    // The route's `notImplementedYet` returns 503 Service Unavailable
    // (NOT 501, which is a common misread — 503 communicates "we know
    // about this endpoint but can't serve it right now").
    // Once roost wave 2a.6 lands, flip this to 200 + Admin SDK read of
    // the swapped currentManifestId.
    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: TARGET_MANIFEST_ID,
    });
    expect(status).toBe(503);
  });
});
