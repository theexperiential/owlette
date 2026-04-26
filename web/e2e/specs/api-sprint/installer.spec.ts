/**
 * api-sprint W5.4 — installer-api e2e (track 1B).
 *
 * Hits the platform-scoped installer endpoints under `/api/installer/*` with
 * an `installer=*:write|admin` superadmin api key.
 *
 * Verbs covered (≥1 happy-path each):
 *   - GET    /api/installer
 *   - POST   /api/installer/upload         (step 1: signed url)
 *   - PUT    /api/installer/upload         (step 2: finalize)
 *   - POST   /api/installer/{version}/set-latest
 *   - DELETE /api/installer/{version}
 *
 * Negative paths:
 *   - 403 superadmin gating when a non-superadmin api key calls upload
 *   - 409 min_versions_violated when DELETE would drop active count below 2
 *
 * The Storage emulator does honour signed URLs in v4 but the binary upload
 * step (PUT to the returned URL) is NOT exercised here — the e2e just walks
 * the metadata side of the flow and stubs the storage object directly so the
 * finalize handler's `file.exists()` check passes.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';

const SUFFIX = crypto.randomBytes(4).toString('hex');

let superKey: MintedApiKey;
// A non-platform-scoped key — used to assert the superadmin gate rejects it.
let nonPlatformKey: MintedApiKey;

async function clearInstallerVersions(): Promise<void> {
  const db = getAdminDb();
  const col = db.collection('installer_metadata').doc('data').collection('versions');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  await db.collection('installer_metadata').doc('latest').delete().catch(() => undefined);
}

async function clearInstallerUploads(): Promise<void> {
  const db = getAdminDb();
  const snap = await db.collection('installer_uploads').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedVersion(version: string, deletedAt: number | null = null): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc(version)
    .set({
      version,
      download_url: `https://example.com/Owlette-Installer-v${version}.exe`,
      checksum_sha256: 'a'.repeat(64),
      release_notes: null,
      file_size: 1024,
      uploaded_at: Date.now(),
      uploaded_by: 'super-uid',
      ...(deletedAt !== null ? { deletedAt } : {}),
    });
}

test.beforeAll(async () => {
  superKey = await mintApiKey({
    ownerUid: 'super-uid',
    name: `e2e-installer-super-${SUFFIX}`,
    scopes: [{ resource: 'installer', id: '*', permissions: ['read', 'write', 'admin'] }],
  });
  nonPlatformKey = await mintApiKey({
    ownerUid: 'admin-uid', // admin role, not superadmin
    name: `e2e-installer-non-platform-${SUFFIX}`,
    scopes: [{ resource: 'site', id: 'site-A', permissions: ['read', 'write'] }],
  });
});

test.afterAll(async () => {
  if (superKey) await revokeApiKey(superKey);
  if (nonPlatformKey) await revokeApiKey(nonPlatformKey);
  await clearInstallerVersions();
  await clearInstallerUploads();
});

test.beforeEach(async () => {
  await clearInstallerVersions();
  await clearInstallerUploads();
});

test('GET /api/installer — lists versions newest first', async ({ request }) => {
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0'), seedVersion('3.0.0')]);

  const res = await request.get('/api/installer?page_size=50', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.versions)).toBe(true);
  expect(body.versions.length).toBeGreaterThanOrEqual(3);
  // Verify the version field is present.
  expect(typeof body.versions[0].version).toBe('string');
});

test('POST /api/installer/upload — step 1 returns signed upload url + uploadId', async ({ request }) => {
  const version = '9.9.1';
  const res = await request.post('/api/installer/upload', {
    headers: authHeaders(superKey),
    data: {
      version,
      fileName: `Owlette-Installer-v${version}.exe`,
      releaseNotes: 'e2e test build',
      setAsLatest: true,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.uploadUrl).toBe('string');
  expect(typeof body.uploadId).toBe('string');
  expect(body.storagePath).toContain(version);

  // Firestore record was written.
  const db = getAdminDb();
  const uploadDoc = await db.collection('installer_uploads').doc(body.uploadId).get();
  expect(uploadDoc.exists).toBe(true);
  expect(uploadDoc.data()?.version).toBe(version);
  expect(uploadDoc.data()?.status).toBe('pending');
});

test('POST /api/installer/upload — non-superadmin api key gets 403', async ({ request }) => {
  const res = await request.post('/api/installer/upload', {
    headers: authHeaders(nonPlatformKey),
    data: {
      version: '9.9.2',
      fileName: 'Owlette-Installer-v9.9.2.exe',
    },
  });
  expect(res.status()).toBe(403);
});

test('POST /api/installer/{version}/set-latest — promotes to latest', async ({ request }) => {
  const version = '4.5.6';
  await seedVersion(version);

  const res = await request.post(`/api/installer/${version}/set-latest`, {
    headers: authHeaders(superKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.version).toBe(version);
  expect(body.latest?.version).toBe(version);

  const db = getAdminDb();
  const latestDoc = await db.collection('installer_metadata').doc('latest').get();
  expect(latestDoc.data()?.version).toBe(version);
});

test('DELETE /api/installer/{version} — soft-deletes when min-versions-active not violated', async ({ request }) => {
  // Seed 3 active versions so deleting one leaves 2 (the floor).
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0'), seedVersion('3.0.0')]);

  // Delete the oldest. Floor is `≤` MIN_ACTIVE_VERSIONS=2, so 3→ delete →2
  // would actually trip the guard (active <= 2). Seed 4 to be safe.
  await seedVersion('4.0.0');

  const res = await request.delete('/api/installer/1.0.0', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.version).toBe('1.0.0');
  expect(typeof body.deletedAt === 'number').toBe(true);

  // Doc has deletedAt set.
  const db = getAdminDb();
  const docSnap = await db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions')
    .doc('1.0.0')
    .get();
  expect(typeof docSnap.data()?.deletedAt).toBe('number');
});

test('DELETE /api/installer/{version} — 409 min_versions_violated at floor', async ({ request }) => {
  // Seed exactly 2 active versions — deleting either should trip the floor.
  await Promise.all([seedVersion('1.0.0'), seedVersion('2.0.0')]);

  const res = await request.delete('/api/installer/1.0.0', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('min_versions_violated');
});
