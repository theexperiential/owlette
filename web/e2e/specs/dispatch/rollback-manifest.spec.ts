/**
 * Dispatch — rollback to manifest (D5.2)
 *
 * Covers `/api/roosts/{roostId}/rollback` end-to-end now that roost
 * wave 2a.6 has landed (`feat(roost): replace folders API stubs with
 * real roosts routes (cutover)`). The route runs a firestore CAS
 * transaction that swaps `currentManifestId` to the target and pushes
 * the old current onto `previousManifestId`.
 *
 * Role contract: `requireAdminOrIdToken` in `lib/apiAuth.server.ts:84`
 * is a misnomer — it actually requires `role === 'superadmin'` (line
 * 103). Admin + member both 403 before any site-scope check even runs.
 * The roost admin endpoints are therefore superadmin-only, matching
 * the permission-model-split's platform-admin carve-out for cross-
 * cutting ops.
 *
 * Uses the `page.evaluate(fetch)` pattern from B3.4 to preserve the
 * HttpOnly `__session` cookie Playwright's request context would
 * otherwise strip.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';

const SITE_ID = 'site-A';
const ROOST_ID = 'e2e-roost-folder';
const TARGET_MANIFEST_ID = 'manifest-target-abc';
const CURRENT_MANIFEST_ID = 'manifest-current-xyz';

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

  test('valid body atomically swaps currentManifestId (200)', async ({ page }) => {
    // Full path: auth + role gate + body validation + site scope +
    // firestore CAS transaction. Seed a roost with an explicit current
    // manifest and the target manifest in its history, dispatch the
    // rollback, then verify via Admin SDK that `currentManifestId`
    // flipped to the target and `previousManifestId` captured the
    // prior current.
    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(SITE_ID)
      .collection('roosts')
      .doc(ROOST_ID);

    await roostRef.set({
      currentManifestId: CURRENT_MANIFEST_ID,
      previousManifestId: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await Promise.all(
      [CURRENT_MANIFEST_ID, TARGET_MANIFEST_ID].map((id) =>
        roostRef.collection('manifests').doc(id).set({
          schemaVersion: 1,
          createdAt: Timestamp.now(),
        }),
      ),
    );

    const status = await rollbackStatus(page, {
      siteId: SITE_ID,
      targetManifestId: TARGET_MANIFEST_ID,
    });
    expect(status).toBe(200);

    const after = (await roostRef.get()).data() ?? {};
    expect(after.currentManifestId).toBe(TARGET_MANIFEST_ID);
    expect(after.previousManifestId).toBe(CURRENT_MANIFEST_ID);
    expect(after.rolledBackFrom).toBe(CURRENT_MANIFEST_ID);
  });
});
