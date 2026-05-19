/**
 * Roosts — concurrent publish (task 4.2)
 *
 * Two operators race a publish: A reads head = v3, B's publish lands as v4
 * first, A submits with `expectedCurrentVersionId` pinned to v3 → 412
 * `version_stale`. A re-reads, retries with v4 as expected, retry mints v5
 * (NOT v4 — B took that slot).
 *
 * SCOPE LIMITATION (api-only). `web/lib/roostUpload.ts` does NOT send
 * `expectedCurrentVersionId` (lines 285-292), so the route's CAS branch never
 * trips from the dashboard path — concurrent dashboard publishes succeed via
 * firestore optimistic concurrency with adjacent monotonic versionNumbers.
 * `ProjectDistributionDialog` also lacks a retry-banner UX for 412 — terminal
 * errors surface a generic `toast.error('upload failed', …)` (line 551). Both
 * gaps flagged for follow-up. We exercise the API contract via the browser's
 * authenticated session, mirroring `access-control/admin-api-403.spec.ts`.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import {
  seedMachine,
  seedRoostWithVersionHistory,
  seedChunks,
  TEST_SITES,
} from '../../helpers/seed';
import { FieldValue } from 'firebase-admin/firestore';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-concurrent-publish-target';
const ROOST_ID = 'rst_test_concurrent_001';
const ROOST_NAME = 'lobby';
const EXTRACT_PATH = 'C:/ProgramData/Owlette/projects/lobby';

// Distinct hashes per attempt — route mints versionId from sha256(version
// body), so a reused hash would yield the same versionId and obscure the tx.
const HASH_ATTEMPT = '7a20d190ca7b4eeb510bb72e4357cf7857a8682290ceef206ac0eaa137c0f16e';
const HASH_RETRY = 'e55684f381f455a91afad9e022502641050d4d1ec429e03ee020cc3d80d6d5dd';
const COMPETING_V4_ID = 'vrs_competing_v4';

async function finalizeAs(
  page: Page,
  expectedHead: string,
  hash: string,
  path: string,
  description: string,
) {
  return page.evaluate(
    async (args) => {
      const res = await fetch(`/api/roosts/${args.roostId}/versions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args.body),
      });
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: (await res.json()) as Record<string, unknown>,
      };
    },
    {
      roostId: ROOST_ID,
      body: {
        siteId: SITE_ID,
        version: {
          schemaVersion: 2,
          mediaType: 'application/vnd.owlette.version.v1+json',
          config: {},
          files: [{ path, size: 4096, chunks: [{ hash, size: 4096 }] }],
        },
        expectedCurrentVersionId: expectedHead,
        name: ROOST_NAME,
        targets: [MACHINE_ID],
        extractPath: EXTRACT_PATH,
        description,
      },
    },
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
  await Promise.all(
    [HASH_ATTEMPT, HASH_RETRY].map((h) =>
      db.collection('siteChunks').doc(h).delete().catch(() => undefined),
    ),
  );
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    name: ROOST_NAME,
    targets: [MACHINE_ID],
    extractPath: EXTRACT_PATH,
  });
  await seedChunks(SITE_ID, [HASH_ATTEMPT, HASH_RETRY]);
});

test.afterEach(cleanup);

test('CAS conflict surfaces as 412 version_stale; retry mints the next monotonic version', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  const db = getAdminDb();
  const roostRef = db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID);

  // Operator A reads the head — v3 from seedRoostWithVersionHistory.
  const operatorAExpectedHead = (await roostRef.get()).data()?.currentVersionId as string;
  expect(operatorAExpectedHead).toBe(`vrs_${ROOST_ID}_v3`);

  // ─── operator B's publish lands as v4 in the race window ────────────
  // Direct firestore writes; mirror the real route's tx ordering.
  await roostRef.collection('versions').doc(COMPETING_V4_ID).set({
    versionId: COMPETING_V4_ID,
    versionNumber: 4,
    description: 'competing operator B publish',
    versionUrl: `https://e2e-seed.test/version-${COMPETING_V4_ID}.json`,
    createdAt: new Date(),
    createdBy: 'operator-b',
    totalSize: 4096,
    totalFiles: 1,
    parentVersionId: `vrs_${ROOST_ID}_v3`,
  });
  await roostRef.set(
    {
      versionCounter: 4,
      currentVersionId: COMPETING_V4_ID,
      currentVersionNumber: 4,
      currentVersionDescription: 'competing operator B publish',
      previousVersionId: `vrs_${ROOST_ID}_v3`,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // ─── operator A submits with stale expected (= v3) ──────────────────
  const attempt = await finalizeAs(
    page,
    operatorAExpectedHead,
    HASH_ATTEMPT,
    'first-attempt.toe',
    'first attempt',
  );

  expect(attempt.status).toBe(412);
  expect(attempt.contentType ?? '').toMatch(/application\/problem\+json/);
  expect(attempt.body).toMatchObject({
    status: 412,
    title: 'head changed',
    code: 'version_stale',
  });
  // detail surfaces the actual current head so the client can re-read.
  expect(attempt.body.detail as string).toContain(COMPETING_V4_ID);

  // Pointer state unchanged by the failed attempt.
  const afterFailure = await roostRef.get();
  expect(afterFailure.data()?.currentVersionId).toBe(COMPETING_V4_ID);
  expect(afterFailure.data()?.versionCounter).toBe(4);

  // ─── operator A retries with the refreshed head ─────────────────────
  const retry = await finalizeAs(
    page,
    afterFailure.data()?.currentVersionId as string,
    HASH_RETRY,
    'retry.toe',
    'retry after competing publish',
  );

  // Retry succeeds; versionNumber MUST be 5 (not 4 — B already took it).
  expect(retry.status).toBe(201);
  expect(retry.body.versionNumber).toBe(5);
  expect(retry.body.previousVersionId).toBe(COMPETING_V4_ID);
  const retryVersionId = retry.body.versionId as string;
  expect(retryVersionId).toMatch(/^[a-f0-9]{64}$/);
  expect(retry.body.currentVersionId).toBe(retryVersionId);

  // Final firestore state — pointer flipped to retry, counter at 5,
  // previousVersionId points back at B's v4.
  await expect.poll(async () => {
    const data = (await roostRef.get()).data() ?? {};
    const { currentVersionId, previousVersionId, versionCounter } = data;
    return { currentVersionId, previousVersionId, versionCounter };
  }, { timeout: 5_000, intervals: [100, 250, 500] }).toEqual({
    currentVersionId: retryVersionId,
    previousVersionId: COMPETING_V4_ID,
    versionCounter: 5,
  });

  const retryDocSnap = await roostRef.collection('versions').doc(retryVersionId).get();
  expect(retryDocSnap.exists).toBe(true);
  expect(retryDocSnap.data()).toMatchObject({
    versionNumber: 5,
    description: 'retry after competing publish',
    parentVersionId: COMPETING_V4_ID,
  });

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
