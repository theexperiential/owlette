#!/usr/bin/env node
/**
 * Site Owner Membership Backfill
 *
 * Repairs accounts stranded by the createSite membership gap: `createSite`
 * stamped `sites/{siteId}.owner` but never added the id to
 * `users/{uid}.sites[]`. The server honours ownership (firestore.rules,
 * GET /api/sites, apiAuth) but the client site list resolves membership only,
 * so those sites are invisible in-product to the users who created them —
 * dashboard shows "create your first site", /add reports "no sites available",
 * and every site-scoped page has nothing to select.
 *
 * The code fix (batched arrayUnion in web/lib/actions/createSite.server.ts) is
 * not retroactive, and `createSite` returns `already_exists` on retry, so
 * affected users cannot self-heal by recreating. This script closes the gap
 * for sites created between 1756e5f (2026-03-20) and that fix.
 *
 * For every `sites/{siteId}` with an `owner`, ensures `owner` has that id in
 * `users/{owner}.sites[]`. Idempotent — a second run reports 0 to repair.
 *
 * Reports the full blast radius before writing anything, so the count can be
 * reviewed before a production mutation.
 *
 * Usage:
 *   node scripts/backfill-site-owner-membership.mjs --env=prod --dry-run
 *   node scripts/backfill-site-owner-membership.mjs --env=prod
 *   node scripts/backfill-site-owner-membership.mjs --env=dev --dry-run
 *
 * Credentials:
 *   Reads FIREBASE_PROJECT_ID_{DEV|PROD}, FIREBASE_CLIENT_EMAIL_{DEV|PROD},
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD} from the environment, falling back to the
 *   unsuffixed web/.env.local vars. dev and prod are SEPARATE Firebase
 *   projects — the fallback targets whichever project web/.env.local points
 *   at, so verify the printed project id before running live.
 *
 *   web/.env.local, .claude/.env.local, and scripts/.env.local are auto-loaded
 *   if present.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules — resolve it from there so the
// script runs without a root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');

// ---- CLI parsing ------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const dryRun = getFlag('dry-run') === true;
const env = getFlag('env');

if (env !== 'dev' && env !== 'prod') {
  console.error(
    'Usage: node scripts/backfill-site-owner-membership.mjs --env=dev|prod [--dry-run]'
  );
  process.exit(1);
}

// ---- .env loading -----------------------------------------------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

// ---- Credentials ------------------------------------------------------------

const suffix = env === 'prod' ? '_PROD' : '_DEV';
const projectId =
  process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey =
  process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`❌ Missing Firebase credentials for env=${env}.`);
  console.error(`   Set FIREBASE_PROJECT_ID${suffix}, FIREBASE_CLIENT_EMAIL${suffix},`);
  console.error(`   and FIREBASE_PRIVATE_KEY${suffix} (or the unsuffixed equivalents).`);
  process.exit(1);
}

const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

const usingFallback = !process.env[`FIREBASE_PROJECT_ID${suffix}`];
if (usingFallback) {
  console.warn(
    `⚠️  No FIREBASE_PROJECT_ID${suffix} set — falling back to plain FIREBASE_PROJECT_ID (${projectId}).`
  );
  console.warn(`   Verify this matches the intended ${env} project before continuing.\n`);
}

// ---- Backfill ---------------------------------------------------------------

/** Firestore caps a write batch at 500 operations. */
const BATCH_LIMIT = 400;

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Site owner membership backfill — env=${env}, project=${projectId}\n`
  );

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
  const db = admin.firestore();

  const sitesSnap = await db.collection('sites').get();
  console.log(`scanned ${sitesSnap.size} site document(s)\n`);

  /** siteId -> owner uid, for sites that declare an owner. */
  const ownedSites = [];
  const ownerless = [];
  for (const doc of sitesSnap.docs) {
    const owner = doc.data()?.owner;
    if (typeof owner === 'string' && owner.length > 0) {
      ownedSites.push({ siteId: doc.id, owner });
    } else {
      ownerless.push(doc.id);
    }
  }

  // Read each distinct owner's user doc once, not once per site.
  const ownerUids = [...new Set(ownedSites.map((s) => s.owner))];
  const userDocs = new Map();
  await Promise.all(
    ownerUids.map(async (uid) => {
      const snap = await db.collection('users').doc(uid).get();
      userDocs.set(uid, snap.exists ? (snap.data() ?? {}) : null);
    })
  );

  const toRepair = [];
  const alreadyOk = [];
  const missingUserDoc = [];

  for (const { siteId, owner } of ownedSites) {
    const userData = userDocs.get(owner);
    if (userData === null) {
      missingUserDoc.push({ siteId, owner });
      continue;
    }
    const sites = Array.isArray(userData.sites) ? userData.sites : [];
    if (sites.includes(siteId)) alreadyOk.push({ siteId, owner });
    else toRepair.push({ siteId, owner });
  }

  // ---- Blast radius, before any write ----
  const affectedUsers = new Set(toRepair.map((r) => r.owner));
  console.log('--- blast radius ---');
  console.log(`  sites with an owner        : ${ownedSites.length}`);
  console.log(`  already correct            : ${alreadyOk.length}`);
  console.log(`  TO REPAIR                  : ${toRepair.length}`);
  console.log(`  users affected             : ${affectedUsers.size}`);
  if (ownerless.length > 0) {
    console.log(`  sites with no owner field  : ${ownerless.length}  (skipped)`);
  }
  if (missingUserDoc.length > 0) {
    console.log(
      `  owner has no user document : ${missingUserDoc.length}  (skipped — cannot repair)`
    );
  }
  console.log('');

  if (toRepair.length > 0) {
    console.log('sites to repair:');
    for (const { siteId, owner } of toRepair) {
      console.log(`  ${siteId}  ->  users/${owner}.sites[]`);
    }
    console.log('');
  }

  if (missingUserDoc.length > 0) {
    // Worth surfacing individually: these are orphaned sites whose owner no
    // longer has an account, which no backfill can resolve.
    console.log('⚠️  skipped — owner has no user document:');
    for (const { siteId, owner } of missingUserDoc) {
      console.log(`  ${siteId}  (owner ${owner})`);
    }
    console.log('');
  }

  if (toRepair.length === 0) {
    console.log('✅ nothing to repair.\n');
    return;
  }

  if (dryRun) {
    console.log('[DRY RUN] no writes performed.\n');
    return;
  }

  if (env === 'prod') {
    const confirmed = await promptYesNo(
      `Write ${toRepair.length} membership entr${toRepair.length === 1 ? 'y' : 'ies'} ` +
        `across ${affectedUsers.size} user(s) in PRODUCTION (${projectId})? [y/N] `
    );
    if (!confirmed) {
      console.log('aborted — no writes performed.\n');
      return;
    }
  }

  let written = 0;
  for (let i = 0; i < toRepair.length; i += BATCH_LIMIT) {
    const chunk = toRepair.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { siteId, owner } of chunk) {
      batch.update(db.collection('users').doc(owner), {
        sites: admin.firestore.FieldValue.arrayUnion(siteId),
      });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  committed ${written}/${toRepair.length}`);
  }

  console.log(`\n✅ repaired ${written} membership entr${written === 1 ? 'y' : 'ies'}.\n`);
}

main().catch((err) => {
  console.error('\n❌ backfill failed:', err);
  process.exit(1);
});
