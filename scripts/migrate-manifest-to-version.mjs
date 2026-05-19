#!/usr/bin/env node
/**
 * Firestore migration: `sites/{siteId}/roosts/{roostId}/manifests/*` →
 *                      `sites/{siteId}/roosts/{roostId}/versions/*`.
 *
 * Part of roost manifest → version rename (rename-map.md §9). For every
 * roost under every site, this script:
 *   1. Fetches the `manifests/` sub-collection, sorted by `createdAt` asc.
 *   2. Writes each doc to `versions/{manifestDocId}` with the original
 *      fields plus `versionNumber` (1-indexed integer), `versionId`
 *      (== doc id), and `description` (preserved if present, else null).
 *   3. Updates the roost doc:
 *        - `versionCounter` = total manifest count
 *        - `currentVersionId` = old `currentManifestId`
 *        - `previousVersionId` = old `previousManifestId`
 *        - original `currentManifestId` / `previousManifestId` fields
 *          are deleted from the roost doc.
 *   4. Verifies `versions/` count == `manifests/` count; on mismatch the
 *      roost is flagged and its `manifests/` docs are NOT deleted.
 *   5. Deletes `manifests/*` docs (only after verification passes).
 *   6. If `roost.name` is missing/empty, backfills with
 *      `untitled roost {id-prefix-8chars}`.
 *
 * Idempotent: a roost whose `versions/` sub-collection already matches
 * the `manifests/` sub-collection count (or whose `manifests/` is empty
 * with `versions/` populated) is skipped on subsequent runs.
 *
 * A `migration-log.json` file is written alongside the script recording
 * the before/after state of every touched roost, enabling `--rollback`.
 *
 * Usage:
 *   node scripts/migrate-manifest-to-version.mjs --help
 *   node scripts/migrate-manifest-to-version.mjs --dry-run
 *   node scripts/migrate-manifest-to-version.mjs --project dev
 *   node scripts/migrate-manifest-to-version.mjs --project prod --site SITE_ID
 *   node scripts/migrate-manifest-to-version.mjs --rollback --project dev
 *
 * Flags:
 *   --dry-run              report intended writes; no mutations
 *   --project <dev|prod>   target Firebase project (default: dev)
 *   --site <siteId>        limit to one site (default: all sites)
 *   --concurrency <n>      parallel roost migrations (default: 4)
 *   --rollback             reverse a previous run using migration-log.json
 *   --log-file <path>      override log file path
 *                          (default: scripts/migration-log.json)
 *   -h, --help             show usage and exit
 *
 * Exit codes: 0 on clean success, 1 if any roost failed to migrate or
 * rollback, 2 on fatal setup error (bad flag, missing creds, etc).
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules — resolve from there so this
// script runs without a root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));

// ─── CLI parsing ───────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/migrate-manifest-to-version.mjs [options]

Migrates \`sites/*/roosts/*/manifests/*\` → \`sites/*/roosts/*/versions/*\`
and backfills \`versionNumber\` + \`versionCounter\` + renamed pointer fields.

Options:
  --dry-run              report intended writes; no mutations
  --project <dev|prod>   target Firebase project (default: dev)
  --site <siteId>        limit to one site (default: all)
  --concurrency <n>      parallel roost migrations (default: 4)
  --rollback             reverse a previous run using migration-log.json
  --log-file <path>      override log file path
                         (default: scripts/migration-log.json)
  -h, --help             show this message and exit

Exit codes: 0 = clean, 1 = per-roost failures, 2 = fatal setup error.
`;

function parseArgs(argv) {
  const out = {
    dryRun: false,
    project: 'dev',
    site: undefined,
    concurrency: 4,
    rollback: false,
    logFile: join(__dirname, 'migration-log.json'),
    help: false,
  };
  const args = argv.slice();
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--rollback':
        out.rollback = true;
        break;
      case '--project': {
        const v = args.shift();
        if (v !== 'dev' && v !== 'prod') {
          throw new Error(`--project must be 'dev' or 'prod' (got ${JSON.stringify(v)})`);
        }
        out.project = v;
        break;
      }
      case '--site': {
        const v = args.shift();
        if (!v || v.startsWith('-')) throw new Error('--site requires a siteId value');
        out.site = v;
        break;
      }
      case '--concurrency': {
        const v = args.shift();
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1 || n > 64) {
          throw new Error(`--concurrency must be an integer between 1 and 64 (got ${JSON.stringify(v)})`);
        }
        out.concurrency = n;
        break;
      }
      case '--log-file': {
        const v = args.shift();
        if (!v || v.startsWith('-')) throw new Error('--log-file requires a path value');
        out.logFile = v;
        break;
      }
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`ERROR: ${err.message}\n`);
  console.error(USAGE);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

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

function resolveCredentials(project) {
  const suffix = project === 'prod' ? '_PROD' : '_DEV';
  const projectId =
    process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
  const clientEmail =
    process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey =
    process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

  // Standard pattern also supported for parity with gcloud tooling.
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (projectId && clientEmail && rawPrivateKey) {
    return {
      mode: 'explicit',
      projectId,
      clientEmail,
      privateKey: rawPrivateKey.replace(/\\n/g, '\n'),
    };
  }

  if (gacPath && existsSync(gacPath)) {
    return { mode: 'gac', gacPath };
  }

  return null;
}

// ─── Firestore init ────────────────────────────────────────────────────

let admin;
let db;

function initFirestore(creds) {
  admin = require('firebase-admin');
  if (creds.mode === 'explicit') {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: creds.projectId,
        clientEmail: creds.clientEmail,
        privateKey: creds.privateKey,
      }),
    });
  } else {
    // GOOGLE_APPLICATION_CREDENTIALS — applicationDefault reads it.
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  db = admin.firestore();
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Firestore Timestamp comparator. Null / missing timestamps sort first so
 * the oldest (including unknown-date) manifests still get stable version
 * numbers on re-runs.
 */
function compareByCreatedAtAsc(a, b) {
  const at = a.data().createdAt;
  const bt = b.data().createdAt;
  const av = at?.toMillis?.() ?? (typeof at === 'number' ? at : 0);
  const bv = bt?.toMillis?.() ?? (typeof bt === 'number' ? bt : 0);
  if (av !== bv) return av - bv;
  // Stable tiebreaker on doc id so re-runs produce identical ordering.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Fan-out with bounded concurrency. */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function loadLog(path) {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error('log file is malformed (missing entries array)');
    }
    return parsed;
  } catch (err) {
    throw new Error(`failed to read log file at ${path}: ${err.message}`);
  }
}

function writeLog(path, log) {
  writeFileSync(path, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

// ─── Migration: forward ────────────────────────────────────────────────

/**
 * Returns a migration plan for a single roost, or null if already migrated.
 * Reads only — no writes.
 */
async function planRoost(siteId, roostId) {
  const roostRef = db.collection('sites').doc(siteId).collection('roosts').doc(roostId);
  const roostSnap = await roostRef.get();
  if (!roostSnap.exists) return null;
  const roost = roostSnap.data() || {};

  const manifestsSnap = await roostRef.collection('manifests').get();
  const versionsSnap = await roostRef.collection('versions').get();

  const manifestCount = manifestsSnap.size;
  const versionCount = versionsSnap.size;

  // Idempotency: already migrated if versions/ is populated and at least
  // matches the manifests/ count (either manifests/ still exists from a
  // failed delete, or has been cleaned up).
  const alreadyMigrated =
    versionCount > 0 && (manifestCount === 0 || versionCount >= manifestCount);

  const needsNameBackfill = !roost.name || typeof roost.name !== 'string' || !roost.name.trim();

  // If fully migrated AND name is already populated, nothing to do.
  if (alreadyMigrated && !needsNameBackfill) return null;

  const ordered = [...manifestsSnap.docs].sort(compareByCreatedAtAsc);

  return {
    siteId,
    roostId,
    roostRef,
    roostData: roost,
    manifestDocs: ordered,
    manifestCount,
    versionCount,
    alreadyMigrated,
    needsNameBackfill,
  };
}

async function migrateRoost(plan, { dryRun }, logEntries) {
  const { siteId, roostId, roostRef, roostData, manifestDocs, alreadyMigrated, needsNameBackfill } =
    plan;

  const entry = {
    kind: 'migrate',
    siteId,
    roostId,
    migratedAt: new Date().toISOString(),
    before: {
      name: roostData.name ?? null,
      currentManifestId: roostData.currentManifestId ?? null,
      previousManifestId: roostData.previousManifestId ?? null,
      currentVersionId: roostData.currentVersionId ?? null,
      previousVersionId: roostData.previousVersionId ?? null,
      versionCounter: roostData.versionCounter ?? null,
      manifestCount: plan.manifestCount,
      versionCount: plan.versionCount,
    },
    after: {
      versionsWritten: 0,
      versionCounter: null,
      currentVersionId: null,
      previousVersionId: null,
      nameBackfilled: false,
      manifestsDeleted: 0,
    },
    writtenVersionIds: [],
  };

  // 1. Plan version writes.
  const versionWrites = manifestDocs.map((doc, i) => ({
    id: doc.id,
    number: i + 1,
    data: doc.data(),
  }));

  console.log(
    `  [${siteId}/${roostId}] ${dryRun ? '[DRY] ' : ''}` +
      `migrating (${manifestDocs.length} manifest${manifestDocs.length === 1 ? '' : 's'}` +
      `, versions=${plan.versionCount}${alreadyMigrated ? ', already-migrated' : ''}` +
      `${needsNameBackfill ? ', needs-name' : ''})`,
  );

  if (!dryRun && !alreadyMigrated && versionWrites.length > 0) {
    // 2. Write versions. Use BulkWriter so a roost with thousands of
    // manifests doesn't exceed the 500-write-per-commit cap.
    const bulk = db.bulkWriter();
    for (const v of versionWrites) {
      const payload = {
        ...v.data,
        versionNumber: v.number,
        versionId: v.id,
        description: v.data.description ?? null,
      };
      bulk.set(roostRef.collection('versions').doc(v.id), payload);
      entry.writtenVersionIds.push(v.id);
    }
    await bulk.close();
    entry.after.versionsWritten = versionWrites.length;
  } else if (dryRun) {
    entry.writtenVersionIds = versionWrites.map((v) => v.id);
    entry.after.versionsWritten = versionWrites.length;
  }

  // 3. Update roost doc — rename pointer fields + set counter.
  const nextCounter = Math.max(
    versionWrites.length,
    typeof roostData.versionCounter === 'number' ? roostData.versionCounter : 0,
  );
  const currentVersionId =
    roostData.currentVersionId ?? roostData.currentManifestId ?? null;
  const previousVersionId =
    roostData.previousVersionId ?? roostData.previousManifestId ?? null;

  const roostUpdate = {
    versionCounter: nextCounter,
    currentVersionId,
    previousVersionId,
  };

  // Only clear old fields if they actually exist — avoids dirty writes on
  // already-migrated roosts that need a name backfill.
  const admin_ = admin;
  if (roostData.currentManifestId !== undefined) {
    roostUpdate.currentManifestId = admin_.firestore.FieldValue.delete();
  }
  if (roostData.previousManifestId !== undefined) {
    roostUpdate.previousManifestId = admin_.firestore.FieldValue.delete();
  }

  if (needsNameBackfill) {
    roostUpdate.name = `untitled roost ${roostId.slice(0, 8)}`;
    entry.after.nameBackfilled = true;
  }

  if (!dryRun) {
    await roostRef.update(roostUpdate);
  }
  entry.after.versionCounter = nextCounter;
  entry.after.currentVersionId = currentVersionId;
  entry.after.previousVersionId = previousVersionId;

  // 4. Verify: re-fetch versions/ count matches manifests/ count.
  let verified = true;
  if (!dryRun && !alreadyMigrated && versionWrites.length > 0) {
    const [versSnap, manSnap] = await Promise.all([
      roostRef.collection('versions').get(),
      roostRef.collection('manifests').get(),
    ]);
    if (versSnap.size < manSnap.size) {
      verified = false;
      console.error(
        `  [${siteId}/${roostId}] VERIFY FAILED — versions=${versSnap.size} < manifests=${manSnap.size}; leaving manifests in place`,
      );
    }
  }

  // 5. Delete manifests.
  if (verified && !dryRun && manifestDocs.length > 0) {
    const bulk = db.bulkWriter();
    for (const doc of manifestDocs) {
      bulk.delete(roostRef.collection('manifests').doc(doc.id));
    }
    await bulk.close();
    entry.after.manifestsDeleted = manifestDocs.length;
  } else if (dryRun) {
    entry.after.manifestsDeleted = manifestDocs.length;
  }

  logEntries.push(entry);

  if (!verified) {
    throw new Error('verification failed — destination version count did not match source');
  }
}

// ─── Migration: rollback ───────────────────────────────────────────────

async function rollbackRoost(entry, { dryRun }) {
  const { siteId, roostId, before, writtenVersionIds } = entry;
  const roostRef = db.collection('sites').doc(siteId).collection('roosts').doc(roostId);

  console.log(
    `  [${siteId}/${roostId}] ${dryRun ? '[DRY] ' : ''}rolling back ` +
      `(${writtenVersionIds.length} version${writtenVersionIds.length === 1 ? '' : 's'})`,
  );

  const admin_ = admin;

  // 1. Re-create manifests/* from versions/*.
  if (writtenVersionIds.length > 0) {
    const copyBulk = dryRun ? null : db.bulkWriter();
    for (const vid of writtenVersionIds) {
      const vSnap = await roostRef.collection('versions').doc(vid).get();
      if (!vSnap.exists) {
        console.warn(`    [${siteId}/${roostId}] version ${vid} missing — skipping restore of that doc`);
        continue;
      }
      const vData = vSnap.data() || {};
      // Strip fields added by the forward migration; preserve everything else.
      const { versionNumber: _vn, versionId: _vid, description: _desc, ...restored } = vData;
      // description was preserved-or-null'd. Only restore it if it was set.
      const manifestPayload =
        _desc !== null && _desc !== undefined ? { ...restored, description: _desc } : restored;
      if (copyBulk) {
        copyBulk.set(roostRef.collection('manifests').doc(vid), manifestPayload);
      }
    }
    if (copyBulk) await copyBulk.close();
  }

  // 2. Restore roost pointer fields + drop new ones.
  const roostUpdate = {};
  if (before.currentManifestId !== null && before.currentManifestId !== undefined) {
    roostUpdate.currentManifestId = before.currentManifestId;
  }
  if (before.previousManifestId !== null && before.previousManifestId !== undefined) {
    roostUpdate.previousManifestId = before.previousManifestId;
  }
  roostUpdate.currentVersionId = admin_.firestore.FieldValue.delete();
  roostUpdate.previousVersionId = admin_.firestore.FieldValue.delete();
  if (before.versionCounter === null || before.versionCounter === undefined) {
    roostUpdate.versionCounter = admin_.firestore.FieldValue.delete();
  } else {
    roostUpdate.versionCounter = before.versionCounter;
  }

  if (!dryRun) {
    await roostRef.update(roostUpdate);
  }

  // 3. Delete the versions/* docs the forward run wrote.
  if (!dryRun && writtenVersionIds.length > 0) {
    const delBulk = db.bulkWriter();
    for (const vid of writtenVersionIds) {
      delBulk.delete(roostRef.collection('versions').doc(vid));
    }
    await delBulk.close();
  }
}

// ─── Entrypoint ────────────────────────────────────────────────────────

async function listRoostRefs(siteFilter) {
  const siteIds = siteFilter
    ? [siteFilter]
    : (await db.collection('sites').listDocuments()).map((d) => d.id);

  const refs = [];
  for (const siteId of siteIds) {
    const roostDocs = await db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .listDocuments();
    for (const r of roostDocs) refs.push({ siteId, roostId: r.id });
  }
  return refs;
}

async function runForward() {
  const log = existsSync(opts.logFile) ? loadLog(opts.logFile) : { version: 1, entries: [] };
  const startedAt = new Date().toISOString();

  const roostRefs = await listRoostRefs(opts.site);
  if (roostRefs.length === 0) {
    console.log('no roosts found — nothing to do');
    return 0;
  }

  console.log(`discovered ${roostRefs.length} roost(s) to inspect`);

  // Plan pass (sequential to keep log ordering deterministic & output clean).
  const plans = [];
  for (const { siteId, roostId } of roostRefs) {
    try {
      const p = await planRoost(siteId, roostId);
      if (p) plans.push(p);
    } catch (err) {
      console.error(`  [${siteId}/${roostId}] plan ERROR: ${err.message}`);
    }
  }

  if (plans.length === 0) {
    console.log('all roosts already migrated — nothing to do');
    return 0;
  }

  console.log(`\n${plans.length} roost(s) need migration; concurrency=${opts.concurrency}\n`);

  const newEntries = [];
  const planResults = await runWithConcurrency(plans, opts.concurrency, async (plan, idx) => {
    const label = `[${idx + 1}/${plans.length}]`;
    try {
      console.log(
        `${label} migrating roost ${plan.roostId} (${plan.manifestDocs.length} manifest${
          plan.manifestDocs.length === 1 ? '' : 's'
        })...`,
      );
      await migrateRoost(plan, { dryRun: opts.dryRun }, newEntries);
      return 'ok';
    } catch (err) {
      console.error(`${label} FAILED ${plan.siteId}/${plan.roostId}: ${err.message}`);
      throw err;
    }
  });

  const failed = planResults.filter((r) => !r.ok).length;

  // Persist log entries (even on partial failure — rollback needs them).
  if (!opts.dryRun && newEntries.length > 0) {
    log.entries.push({
      runStartedAt: startedAt,
      runFinishedAt: new Date().toISOString(),
      project: opts.project,
      site: opts.site ?? null,
      dryRun: false,
      roosts: newEntries,
    });
    writeLog(opts.logFile, log);
    console.log(`\nlog written to ${opts.logFile}`);
  }

  console.log('\nTotals:');
  console.log(`  Roosts inspected : ${roostRefs.length}`);
  console.log(`  Roosts migrated  : ${plans.length - failed}`);
  console.log(`  Roosts failed    : ${failed}`);

  if (opts.dryRun) {
    console.log('\nDry run complete — no writes made. Drop --dry-run to commit.');
    return 0;
  }

  if (failed > 0) {
    console.log('\nMigration completed WITH FAILURES — see log above.');
    return 1;
  }
  console.log('\nMigration complete.');
  return 0;
}

async function runRollback() {
  if (!existsSync(opts.logFile)) {
    console.error(`ERROR: no log file at ${opts.logFile} — cannot rollback.`);
    return 2;
  }
  const log = loadLog(opts.logFile);

  // Flatten per-run entries, filtering by site if requested.
  const entries = [];
  for (const run of log.entries) {
    if (run.dryRun) continue;
    for (const e of run.roosts || []) {
      if (opts.site && e.siteId !== opts.site) continue;
      entries.push(e);
    }
  }

  if (entries.length === 0) {
    console.log('no log entries to rollback (site filter may have excluded everything)');
    return 0;
  }

  // Reverse chronological so the newest migration is undone first.
  entries.reverse();

  console.log(`rolling back ${entries.length} roost migration(s); concurrency=${opts.concurrency}\n`);

  const results = await runWithConcurrency(entries, opts.concurrency, async (entry, idx) => {
    const label = `[${idx + 1}/${entries.length}]`;
    try {
      console.log(`${label} rolling back ${entry.siteId}/${entry.roostId}...`);
      await rollbackRoost(entry, { dryRun: opts.dryRun });
      return 'ok';
    } catch (err) {
      console.error(`${label} FAILED ${entry.siteId}/${entry.roostId}: ${err.message}`);
      throw err;
    }
  });

  const failed = results.filter((r) => !r.ok).length;

  console.log('\nRollback totals:');
  console.log(`  Roosts processed : ${entries.length}`);
  console.log(`  Roosts restored  : ${entries.length - failed}`);
  console.log(`  Roosts failed    : ${failed}`);

  if (opts.dryRun) {
    console.log('\nDry run complete — no writes made.');
    return 0;
  }

  if (failed > 0) {
    console.log('\nRollback completed WITH FAILURES — see log above.');
    return 1;
  }
  console.log('\nRollback complete.');
  return 0;
}

async function main() {
  const creds = resolveCredentials(opts.project);
  if (!creds) {
    console.error(`ERROR: missing Firebase credentials for project=${opts.project}.`);
    console.error('Provide one of:');
    const s = opts.project === 'prod' ? '_PROD' : '_DEV';
    console.error(`  FIREBASE_PROJECT_ID${s} + FIREBASE_CLIENT_EMAIL${s} + FIREBASE_PRIVATE_KEY${s}`);
    console.error('  (or unsuffixed FIREBASE_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY)');
    console.error('  or GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json');
    return 2;
  }

  initFirestore(creds);

  const banner =
    `\n${opts.dryRun ? '[DRY RUN] ' : ''}` +
    `manifest → version migration — project=${opts.project}` +
    (creds.mode === 'explicit' ? `, firestore=${creds.projectId}` : ', firestore=(ADC)') +
    (opts.site ? `, site=${opts.site}` : ', site=all') +
    `, mode=${opts.rollback ? 'rollback' : 'forward'}` +
    `, concurrency=${opts.concurrency}\n`;
  console.log(banner);

  return opts.rollback ? await runRollback() : await runForward();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exit(2);
  });
