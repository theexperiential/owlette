/**
 * Roosts — version-addressing API (task 4.1)
 *
 * Exercises the GET /api/roosts/{roostId}/versions/{versionRef} resolver
 * grammar end-to-end against the next.js handler. Verifies every
 * accepted ref form (alias, stable id, number, prefixed number) maps
 * to the right version doc, and that malformed/missing inputs return
 * the `version_ref_malformed` (400) / `version_not_found` (404) RFC 7807
 * envelopes from `web/lib/resolveVersion.ts`.
 *
 * data plane: none — pure resolver coverage, no push, no chunks.
 *
 * Network: we drive requests via `page.evaluate(fetch(...))` rather than
 * Playwright's `request` fixture — the iron-session `__session` cookie is
 * HttpOnly + Secure, and only the page's own JS context carries it on
 * same-origin fetches (see `web/e2e/specs/access-control/admin-api-403.spec.ts`).
 */
import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import {
  seedMachine,
  seedRoostWithVersionHistory,
  TEST_SITES,
} from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id; // site-A
const MACHINE_ID = 'e2e-version-addr-machine';
const ROOST_ID = 'rst_test_addr_001';
const versionIdFor = (n: number) => `vrs_${ROOST_ID}_v${n}`;

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function getVersion(page: Page, ref: string): Promise<FetchResult> {
  return page.evaluate(
    async ({ roostId, encodedRef, siteId }) => {
      const r = await fetch(
        `/api/roosts/${roostId}/versions/${encodedRef}?siteId=${siteId}`,
        { method: 'GET', credentials: 'same-origin' },
      );
      let parsed: unknown = null;
      try {
        parsed = await r.json();
      } catch {
        // empty body — leave parsed as null
      }
      return {
        status: r.status,
        body:
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : {},
      };
    },
    { roostId: ROOST_ID, encodedRef: ref, siteId: SITE_ID },
  );
}

async function cleanup(): Promise<void> {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: ['v1 work', 'v2 work', 'v3 work'],
  });
});

test.afterEach(async () => {
  await cleanup();
});

// ── happy paths: every ref form should resolve to v3 (current). ────────
//   exception rows pin alias `'previous'`/`'first'` to v2/v1.
const HAPPY_REFS: ReadonlyArray<{
  ref: string;
  expectVersionId: string;
  expectVersionNumber: number;
  expectDescription: string;
}> = [
  { ref: '3',                      expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: '%233',                   expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: 'v3',                     expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: 'V3',                     expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: versionIdFor(3),          expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: 'current',                expectVersionId: versionIdFor(3), expectVersionNumber: 3, expectDescription: 'v3 work' },
  { ref: 'previous',               expectVersionId: versionIdFor(2), expectVersionNumber: 2, expectDescription: 'v2 work' },
  { ref: 'first',                  expectVersionId: versionIdFor(1), expectVersionNumber: 1, expectDescription: 'v1 work' },
];

for (const row of HAPPY_REFS) {
  test(`A — happy path: ref '${row.ref}' resolves to version #${row.expectVersionNumber}`, async ({ page }) => {
    await page.goto('/roosts');
    const res = await getVersion(page, row.ref);
    expect(res.status, `expected 200 for ref '${row.ref}', got body ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body).toMatchObject({
      versionId: row.expectVersionId,
      versionNumber: row.expectVersionNumber,
      description: row.expectDescription,
      roostId: ROOST_ID,
      siteId: SITE_ID,
    });
  });
}

// ── B — number forms across non-current versions ───────────────────────
const NUMBER_REFS: ReadonlyArray<{ ref: string; expectVersionNumber: 1 | 2 }> = [
  { ref: '1', expectVersionNumber: 1 },
  { ref: '2', expectVersionNumber: 2 },
];

for (const row of NUMBER_REFS) {
  test(`B — number ref '${row.ref}' resolves to v${row.expectVersionNumber}`, async ({ page }) => {
    await page.goto('/roosts');
    const res = await getVersion(page, row.ref);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      versionId: versionIdFor(row.expectVersionNumber),
      versionNumber: row.expectVersionNumber,
    });
  });
}

// ── C — error paths: malformed (400) + not-found (404) ─────────────────
const ERROR_REFS: ReadonlyArray<{
  ref: string;
  expectStatus: 400 | 404;
  expectCode: 'version_ref_malformed' | 'version_not_found';
}> = [
  { ref: 'foo',                  expectStatus: 400, expectCode: 'version_ref_malformed' },
  { ref: 'vrs_does_not_exist_xyz', expectStatus: 404, expectCode: 'version_not_found' },
  { ref: '99',                   expectStatus: 404, expectCode: 'version_not_found' },
  { ref: '0',                    expectStatus: 400, expectCode: 'version_ref_malformed' },
  { ref: '-3',                   expectStatus: 400, expectCode: 'version_ref_malformed' },
  { ref: '3abc',                 expectStatus: 400, expectCode: 'version_ref_malformed' },
];

for (const row of ERROR_REFS) {
  test(`C — error: ref '${row.ref}' → ${row.expectStatus} ${row.expectCode}`, async ({ page }) => {
    await page.goto('/roosts');
    const res = await getVersion(page, row.ref);
    expect(res.status, `body: ${JSON.stringify(res.body)}`).toBe(row.expectStatus);
    expect(res.body).toMatchObject({ code: row.expectCode });
  });
}
