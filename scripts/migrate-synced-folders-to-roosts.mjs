#!/usr/bin/env node
/**
 * Firestore migration: `sites/{siteId}/synced_folders/{folderId}` →
 *                      `sites/{siteId}/roosts/{roostId}`.
 *
 * Part of roost public-api wave 1.11. Internal-only renaming — the
 * collection holds the manifest-pointer docs for the v2 distribution
 * engine. No user-visible IDs change; doc ids are preserved verbatim.
 *
 * For each site, this script:
 *   1. Lists every doc under `sites/{siteId}/synced_folders/`.
 *   2. For each doc, copies the top-level fields to
 *      `sites/{siteId}/roosts/{id}` (overwrite semantics — idempotent
 *      because the doc body is the same).
 *   3. Recursively copies the `manifests` + `target_state` + `rollouts`
 *      subcollections under the new parent.
 *   4. After verifying the copy, deletes the source docs + subcollections.
 *
 * Default is `--dry-run`. Pass `--apply` to write + delete. Safe to
 * re-run — if `roosts/{id}` already exists it is overwritten with the
 * latest source snapshot; already-deleted sources are skipped.
 *
 * Usage:
 *   node scripts/migrate-synced-folders-to-roosts.mjs --env=dev
 *   node scripts/migrate-synced-folders-to-roosts.mjs --env=dev --apply
 *   node scripts/migrate-synced-folders-to-roosts.mjs --env=prod --apply --site=SITE_ID
 *
 * Flags:
 *   --env=dev|prod   required — target Firebase project
 *   --apply          commit writes + deletes (otherwise dry-run)
 *   --site=<id>      limit to one site (default: all sites)
 *   --keep-source    copy to roosts/ but do NOT delete synced_folders/
 *                    (for a safety soak period before the hard cutover)
 *
 * Exit codes: 0 on success, 1 on failure of any kind.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules — resolve it from there so
// the script runs without a root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');

// ─── CLI parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const env = getFlag('env');
const apply = getFlag('apply') === true;
const keepSource = getFlag('keep-source') === true;
const siteFilter = getFlag('site') === true ? undefined : getFlag('site');

if (env !== 'dev' && env !== 'prod') {
  console.error(
    'Usage: node scripts/migrate-synced-folders-to-roosts.mjs --env=dev|prod [--apply] [--site=<id>] [--keep-source]',
  );
  process.exit(1);
}

const dryRun = !apply;

// ─── .env loading ──────────────────────────────────────────────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

// ─── Credentials ───────────────────────────────────────────────────────

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId =
  process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey =
  process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`ERROR: missing Firebase credentials for env=${env}.`);
  console.error(`  Set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`  and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed fallbacks).`);
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
});
const db = admin.firestore();

// ─── Core migration ────────────────────────────────────────────────────

/** Subcollections we know live under a synced_folder/roost doc. */
const KNOWN_SUBCOLLECTIONS = ['manifests', 'target_state', 'rollouts'];

async function copyDoc(srcRef, dstRef) {
  const snap = await srcRef.get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (dryRun) return true;
  // Use set() without merge so the destination is an exact snapshot of
  // the source. Safe because this is the first time `roosts/{id}` exists
  // on a clean cutover; on re-run we want the latest source state.
  await dstRef.set(data);
  return true;
}

async function copySubcollection(srcParent, dstParent, subName) {
  const snap = await srcParent.collection(subName).get();
  if (snap.empty) return 0;
  let copied = 0;
  // BulkWriter handles batching + retries — avoids the 500-per-commit cap
  // when a roost has thousands of manifests.
  const bulk = dryRun ? null : db.bulkWriter();
  for (const doc of snap.docs) {
    if (dryRun) {
      copied++;
      continue;
    }
    bulk.set(dstParent.collection(subName).doc(doc.id), doc.data());
    copied++;
  }
  if (bulk) await bulk.close();
  return copied;
}

async function deleteDocAndSubcollections(ref) {
  if (dryRun) return;
  const bulk = db.bulkWriter();
  for (const subName of KNOWN_SUBCOLLECTIONS) {
    const sub = await ref.collection(subName).get();
    for (const d of sub.docs) bulk.delete(d.ref);
  }
  bulk.delete(ref);
  await bulk.close();
}

async function verifyCopy(srcRef, dstRef) {
  if (dryRun) return true;
  const [srcSnap, dstSnap] = await Promise.all([srcRef.get(), dstRef.get()]);
  if (!dstSnap.exists) return false;
  // Compare top-level keys (not values — admin SDK Timestamp equality is
  // brittle). A missing key on the destination is the failure mode we
  // care about; identical shape is good enough before deleting.
  if (!srcSnap.exists) return true; // already migrated + deleted; treat as ok
  const srcKeys = Object.keys(srcSnap.data() || {}).sort();
  const dstKeys = Object.keys(dstSnap.data() || {}).sort();
  if (srcKeys.length !== dstKeys.length) return false;
  for (let i = 0; i < srcKeys.length; i++) {
    if (srcKeys[i] !== dstKeys[i]) return false;
  }
  return true;
}

async function migrateSite(siteId) {
  const srcCol = db.collection('sites').doc(siteId).collection('synced_folders');
  const dstCol = db.collection('sites').doc(siteId).collection('roosts');

  const srcSnap = await srcCol.get();
  if (srcSnap.empty) {
    console.log(`  [${siteId}] no synced_folders to migrate — skipping`);
    return { docsProcessed: 0, subDocsCopied: 0, deleted: 0, failed: 0 };
  }

  let docsProcessed = 0;
  let subDocsCopied = 0;
  let deleted = 0;
  let failed = 0;

  for (const folderDoc of srcSnap.docs) {
    const id = folderDoc.id;
    const srcRef = srcCol.doc(id);
    const dstRef = dstCol.doc(id);

    try {
      const copied = await copyDoc(srcRef, dstRef);
      if (!copied) {
        // src vanished mid-iteration; nothing to do.
        continue;
      }
      let localSubs = 0;
      for (const sub of KNOWN_SUBCOLLECTIONS) {
        localSubs += await copySubcollection(srcRef, dstRef, sub);
      }

      const ok = await verifyCopy(srcRef, dstRef);
      if (!ok) {
        console.error(
          `  [${siteId}/${id}] verify FAILED — destination missing or shape mismatch; skipping delete`,
        );
        failed++;
        continue;
      }

      if (!keepSource) {
        await deleteDocAndSubcollections(srcRef);
        deleted++;
      }

      docsProcessed++;
      subDocsCopied += localSubs;
      console.log(
        `  [${siteId}/${id}] ${dryRun ? '[DRY] would ' : ''}copied doc + ${localSubs} sub-doc(s)` +
          (keepSource ? ' (keep-source)' : dryRun ? ' + would delete source' : ' + deleted source'),
      );
    } catch (err) {
      console.error(`  [${siteId}/${id}] ERROR: ${err.message}`);
      failed++;
    }
  }

  return { docsProcessed, subDocsCopied, deleted, failed };
}

async function listSiteIds() {
  if (siteFilter) return [siteFilter];
  const snap = await db.collection('sites').listDocuments();
  return snap.map((d) => d.id);
}

// ─── Entrypoint ────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}synced_folders → roosts migration — env=${env}, project=${projectId}` +
      (siteFilter ? `, site=${siteFilter}` : ', site=all') +
      (keepSource ? ', keep-source' : '') +
      '\n',
  );

  const siteIds = await listSiteIds();
  if (siteIds.length === 0) {
    console.log('no sites found — nothing to do');
    return 0;
  }

  const totals = { sites: 0, docs: 0, subDocs: 0, deleted: 0, failed: 0 };

  for (const siteId of siteIds) {
    totals.sites++;
    const r = await migrateSite(siteId);
    totals.docs += r.docsProcessed;
    totals.subDocs += r.subDocsCopied;
    totals.deleted += r.deleted;
    totals.failed += r.failed;
  }

  console.log('\nTotals:');
  console.log(`  Sites scanned    : ${totals.sites}`);
  console.log(`  Docs ${dryRun ? 'would copy' : 'copied     '}: ${totals.docs}`);
  console.log(`  Sub-docs         : ${totals.subDocs}`);
  console.log(`  Sources ${dryRun ? 'would del' : 'deleted  '}: ${totals.deleted}`);
  console.log(`  Failed           : ${totals.failed}`);

  if (dryRun) {
    console.log('\nDry run complete — no writes made. Re-run with --apply to commit.');
  } else if (totals.failed > 0) {
    console.log('\nMigration completed WITH FAILURES — see log above.');
    return 1;
  } else {
    console.log('\nMigration complete.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });
