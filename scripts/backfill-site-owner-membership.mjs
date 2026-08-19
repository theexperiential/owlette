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
 * not retroactive, so affected users cannot self-heal. Retrying does not help
 * either, but not for the reason first assumed: site ids are generated word
 * pairs rather than derived from the name, so a retry produces a NEW invisible
 * site instead of colliding. The production data shows exactly that — one user
 * created four sites named "Zagreb" in 148 seconds. This script closes the gap
 * for sites created between 1756e5f (2026-03-20) and that fix.
 *
 * For every `sites/{siteId}` with an `owner`, ensures `owner` has that id in
 * `users/{owner}.sites[]`. Idempotent — a second run reports 0 to repair.
 *
 * NOTE: this is an authorization change, not merely a visibility one.
 * `web/lib/capabilities.ts` resolves site-scoped capabilities from
 * `actor.sites` and never consults ownership, so a stranded owner is currently
 * 403'd on their own site. Membership is what restores that.
 *
 * Reports the full blast radius before writing anything, so the count can be
 * reviewed before a production mutation.
 *
 * Usage:
 *   node scripts/backfill-site-owner-membership.mjs --env=prod --dry-run
 *   node scripts/backfill-site-owner-membership.mjs --env=prod            (interactive confirm)
 *   node scripts/backfill-site-owner-membership.mjs --env=prod --confirm-project=owlette-prod-90a12
 *   node scripts/backfill-site-owner-membership.mjs --env=prod --rollback --log-file=<path>
 *
 * Every live run writes a machine-readable change log next to the script and
 * prints the `--rollback` command that reverses it. arrayUnion is not
 * self-identifying: without that log there is no way to distinguish membership
 * this script added from membership that was always there, and a blind undo
 * would strip legitimate entries.
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
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

/**
 * Strict boolean flag. `getFlag` returns the string after `=`, so a bare
 * `=== true` check silently treats the natural `--dry-run=true` as OFF and
 * takes the live-write path. Accept the bare form, accept explicit
 * true/false, and refuse anything else rather than guessing.
 */
function getBooleanFlag(name) {
  const raw = getFlag(name);
  if (raw === undefined) return false;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  console.error(`❌ --${name} expects no value or true/false, got: ${raw}`);
  process.exit(2);
}

// Reject unknown flags. A typo like `--dryrun` would otherwise parse as "no
// dry-run requested" and take the live-write path silently.
const KNOWN_FLAGS = new Set(['env', 'dry-run', 'rollback', 'log-file', 'confirm-project']);
for (const arg of args) {
  const name = arg.replace(/^--/, '').split('=')[0];
  if (!arg.startsWith('--') || !KNOWN_FLAGS.has(name)) {
    console.error(`❌ unknown argument: ${arg}`);
    console.error(`   known flags: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(', ')}`);
    process.exit(2);
  }
}

const dryRun = getBooleanFlag('dry-run');
const rollback = getBooleanFlag('rollback');
const env = getFlag('env');
const logFileArg = getFlag('log-file');
const confirmProject = getFlag('confirm-project');

if (env !== 'dev' && env !== 'prod') {
  console.error(
    'Usage: node scripts/backfill-site-owner-membership.mjs --env=dev|prod [--dry-run]\n' +
      '       node scripts/backfill-site-owner-membership.mjs --env=dev|prod --rollback --log-file=<path>'
  );
  process.exit(1);
}

if (rollback && dryRun) {
  console.error('❌ --rollback and --dry-run are mutually exclusive.');
  process.exit(2);
}
if (rollback && !logFileArg) {
  console.error('❌ --rollback requires --log-file=<path> from the original run.');
  process.exit(2);
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

/**
 * Projects that require a typed confirmation regardless of the --env flag.
 * Gating on the flag alone trusts an argument over the credentials actually
 * resolved above; this gates on what we are really pointed at.
 */
const PROTECTED_PROJECT_IDS = new Set(['owlette-prod-90a12']);

function promptYesNo(question) {
  return new Promise((resolve) => {
    // Non-interactive confirmation: the operator must name the exact project
    // being written to. Deliberate enough that it cannot be typed by accident
    // or inherited from a stale shell history against the wrong environment.
    if (confirmProject !== undefined) {
      if (confirmProject === projectId) {
        console.log(`${question}y  (--confirm-project=${confirmProject})`);
        resolve(true);
      } else {
        console.error(
          `\n❌ --confirm-project=${confirmProject} does not match the resolved project ${projectId}.`
        );
        resolve(false);
      }
      return;
    }
    if (!process.stdin.isTTY) {
      // readline's callback never fires on a non-TTY stdin, which would hang
      // or exit 0 having done nothing. Refuse explicitly instead.
      console.error(
        '\n❌ confirmation required but stdin is not a TTY.' +
          `\n   Re-run interactively, or pass --confirm-project=${projectId}`
      );
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Reverse a previous run using its change log.
 *
 * arrayUnion is not self-identifying: after the fact, a membership this
 * script added is indistinguishable from one that was always there. Deriving
 * the undo set from `sites/{id}.owner` would over-remove every membership
 * that was already correct before the run, recreating the original bug for
 * different users. So the log written below is the only safe undo source.
 */
async function runRollback(db) {
  const raw = readFileSync(logFileArg, 'utf8');
  const log = JSON.parse(raw);

  if (log.projectId !== projectId) {
    console.error(
      `❌ log was written against project ${log.projectId}, but this run targets ${projectId}.`
    );
    process.exit(2);
  }
  if (!Array.isArray(log.applied) || log.applied.length === 0) {
    console.error('❌ log contains no applied changes to reverse.');
    process.exit(2);
  }

  console.log(`\nROLLBACK — project=${projectId}, log=${logFileArg}`);
  console.log(`  written at : ${log.completedAt}`);
  console.log(`  reversing  : ${log.applied.length} membership entr(ies)\n`);
  for (const { siteId, owner } of log.applied) {
    console.log(`  remove ${siteId} from users/${owner}.sites[]`);
  }
  console.log('');

  if (PROTECTED_PROJECT_IDS.has(projectId)) {
    const ok = await promptYesNo(`Reverse ${log.applied.length} entr(ies) in ${projectId}? [y/N] `);
    if (!ok) {
      console.log('aborted — no writes performed.\n');
      process.exit(3);
    }
  }

  let removed = 0;
  for (let i = 0; i < log.applied.length; i += BATCH_LIMIT) {
    const chunk = log.applied.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { siteId, owner } of chunk) {
      batch.update(db.collection('users').doc(owner), {
        sites: admin.firestore.FieldValue.arrayRemove(siteId),
      });
    }
    await batch.commit();
    removed += chunk.length;
    console.log(`  reversed ${removed}/${log.applied.length}`);
  }
  console.log(`\n✅ rolled back ${removed} membership entr(ies).\n`);
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

  if (rollback) {
    await runRollback(db);
    return;
  }

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
  const softDeleted = [];
  const malformedSites = [];

  for (const { siteId, owner } of ownedSites) {
    const userData = userDocs.get(owner);
    if (userData === null) {
      missingUserDoc.push({ siteId, owner });
      continue;
    }
    // Every sanctioned membership-granting path refuses soft-deleted users
    // (see assignSiteToUser.server.ts), and the delete cascade deliberately
    // clears `sites` as part of its teardown. Re-populating it here would
    // partially reverse that.
    if (typeof userData.deletedAt === 'number') {
      softDeleted.push({ siteId, owner });
      continue;
    }
    // arrayUnion silently replaces a non-array field with a fresh array,
    // destroying whatever was there. Refuse rather than clobber.
    if (userData.sites !== undefined && !Array.isArray(userData.sites)) {
      malformedSites.push({ siteId, owner, actualType: typeof userData.sites });
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
  if (softDeleted.length > 0) {
    console.log(`  owner is soft-deleted      : ${softDeleted.length}  (skipped)`);
  }
  if (malformedSites.length > 0) {
    console.log(`  owner.sites is not an array: ${malformedSites.length}  (skipped)`);
  }
  console.log('');

  if (toRepair.length > 0) {
    // Role matters: membership is what unlocks site-scoped capabilities
    // (web/lib/capabilities.ts consults actor.sites, never ownership), so an
    // admin-role recipient gains materially more than a member-role one.
    // Surface it so the reviewer sees the real authorization delta.
    console.log('sites to repair:');
    for (const { siteId, owner } of toRepair) {
      const u = userDocs.get(owner) ?? {};
      const role = typeof u.role === 'string' ? u.role : 'unknown';
      const email = typeof u.email === 'string' ? u.email : 'unknown';
      console.log(`  ${siteId}  ->  users/${owner}.sites[]   [${role}] ${email}`);
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

  // Gate on the project we actually resolved, not on the --env flag. The flag
  // is an argument; projectId is the truth we just printed.
  if (PROTECTED_PROJECT_IDS.has(projectId)) {
    const confirmed = await promptYesNo(
      `Write ${toRepair.length} membership entr${toRepair.length === 1 ? 'y' : 'ies'} ` +
        `across ${affectedUsers.size} user(s) in PRODUCTION (${projectId})? [y/N] `
    );
    if (!confirmed) {
      console.log('aborted — no writes performed.\n');
      process.exit(3);
    }
  }

  // Write the change log BEFORE committing. arrayUnion is not
  // self-identifying, so if the process dies mid-run this file is the only
  // record of what was intended; entries are marked applied as batches land.
  const logPath =
    logFileArg ||
    join(ROOT, 'scripts', `backfill-site-owner-membership.${projectId}.log.json`);
  const logDoc = {
    script: 'backfill-site-owner-membership',
    projectId,
    env,
    startedAt: new Date().toISOString(),
    completedAt: null,
    planned: toRepair,
    applied: [],
  };
  writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
  console.log(`change log: ${logPath}\n`);

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
    logDoc.applied.push(...chunk);
    writeFileSync(logPath, JSON.stringify(logDoc, null, 2));
    written += chunk.length;
    console.log(`  committed ${written}/${toRepair.length}`);
  }

  logDoc.completedAt = new Date().toISOString();
  writeFileSync(logPath, JSON.stringify(logDoc, null, 2));

  console.log(`\n✅ repaired ${written} membership entr${written === 1 ? 'y' : 'ies'}.`);
  console.log(`   undo with: --env=${env} --rollback --log-file=${logPath}\n`);
}

main().catch((err) => {
  console.error('\n❌ backfill failed:', err);
  process.exit(1);
});
