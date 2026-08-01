#!/usr/bin/env node
/**
 * Customer Doc Backfill (billing-system wave 0.1)
 *
 * Creates the paired `customers/{uid}` billing doc for every account that
 * predates billing. New accounts get theirs at signup (see
 * `web/lib/actions/bootstrapUser.server.ts`); this script covers everyone
 * who signed up before that code shipped, plus any account whose mint
 * failed (the mint is deliberately non-fatal, so this is also the repair
 * path).
 *
 * Backfilled docs get `trialEndsAt: null` — the "pre-go-live account, trial
 * clock not started" sentinel. `resolveBillingState()` reads that as
 * `trialing`, so nothing locks out; the go-live task (5.3) stamps every
 * null with `T0 + 14d` on the announced date.
 *
 * **Keyed by uid, not org id.** `plan.md` writes `customers/{orgId}`, but
 * this codebase has no org entity — tenancy is sites + users, and each site
 * carries `owner: <uid>`. The account owner is the billing customer.
 *
 * Sources walked, in order:
 *   1. every `users/{uid}` doc (soft-deleted accounts are skipped)
 *   2. every distinct `sites/{id}.owner` uid — catches a site whose owner
 *      user doc was hard-deleted, which would otherwise be an unbillable
 *      tenant
 *
 * Idempotent: existing `customers/{uid}` docs are never touched, and the
 * writes use `create()` so a doc minted by a concurrent signup wins.
 *
 * Usage:
 *   node scripts/backfill-customers.mjs --env=dev --dry-run
 *   node scripts/backfill-customers.mjs --env=dev
 *   node scripts/backfill-customers.mjs --env=prod --dry-run
 *   node scripts/backfill-customers.mjs --env=prod
 *
 * Credentials:
 *   Reads FIREBASE_PROJECT_ID_{DEV|PROD}, FIREBASE_CLIENT_EMAIL_{DEV|PROD},
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD} from the environment. Falls back to plain
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (the
 *   web/.env.local vars) if the env-specific ones aren't set — the fallback
 *   targets whatever project web/.env.local is pointed at, so verify before
 *   running live against prod.
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
  console.error('Usage: node scripts/backfill-customers.mjs --env=dev|prod [--dry-run]');
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

/**
 * The doc a pre-go-live account is seeded with. Mirrors `newCustomerDoc()`
 * in `web/lib/types/customer.ts` (the TypeScript source of truth) except
 * for `trialEndsAt`, which is the null "clock not started" sentinel here.
 * Keep the field list in sync with that file.
 */
function backfillCustomerDoc() {
  return {
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    subscriptionTier: null,
    trialEndsAt: null,
    billingState: 'trialing',
    currentPeriodEnd: null,
    defaultPaymentMethod: null,
    taxId: null,
  };
}

const BATCH_SIZE = 400; // Firestore caps batches at 500

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * Commit one batch of `create()` writes. A create fails the whole batch if
 * any target already exists (e.g. a signup minted it between our read and
 * this commit), so fall back to per-doc creates and let only the genuinely
 * colliding ones drop out. Returns the number of docs actually created.
 */
async function commitCreates(db, pending) {
  const batch = db.batch();
  for (const { ref, data } of pending) batch.create(ref, data);

  try {
    await batch.commit();
    return pending.length;
  } catch (err) {
    console.warn(`  ⚠️  batch commit failed (${err.message}) — retrying per-doc`);
    let created = 0;
    for (const { ref, data } of pending) {
      try {
        await ref.create(data);
        created++;
      } catch (docErr) {
        // ALREADY_EXISTS means a concurrent signup won the race — that doc
        // has a live trial clock and must not be overwritten. Anything else
        // is a real failure worth surfacing.
        if (docErr.code === 6 /* ALREADY_EXISTS */) {
          console.log(`  [skip] ${ref.id}: created concurrently`);
        } else {
          console.error(`  ❌ ${ref.id}: ${docErr.message}`);
        }
      }
    }
    return created;
  }
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Customer backfill — env=${env}, project=${projectId}\n`
  );

  if (env === 'prod' && !dryRun) {
    const confirmed = await promptYesNo(
      `⚠️  About to write to PRODUCTION (${projectId}). Continue? [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  const db = admin.firestore();

  const [usersSnap, sitesSnap, customersSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('sites').get(),
    db.collection('customers').get(),
  ]);

  const existing = new Set(customersSnap.docs.map((doc) => doc.id));

  // Candidate uids, in walk order: user docs first, then any site owner
  // without one. `orphanOwners` is reported separately because a billable
  // tenant with no user doc is a data anomaly worth eyeballing.
  const knownUsers = new Set(usersSnap.docs.map((doc) => doc.id));
  const candidates = [];
  const totals = { created: 0, existing: 0, deleted: 0, orphanOwners: 0 };

  for (const doc of usersSnap.docs) {
    if (existing.has(doc.id)) {
      totals.existing++;
      continue;
    }
    // Soft-deleted accounts don't get new billing state written for them —
    // they have no live session and no fleet to bill.
    if (doc.data().deletedAt != null) {
      console.log(`  [skip] ${doc.id}: soft-deleted account`);
      totals.deleted++;
      continue;
    }
    candidates.push(doc.id);
  }

  const seenOwners = new Set();
  for (const doc of sitesSnap.docs) {
    const owner = doc.data().owner;
    if (typeof owner !== 'string' || owner.length === 0) continue;
    if (knownUsers.has(owner) || seenOwners.has(owner)) continue;
    seenOwners.add(owner);
    totals.orphanOwners++;
    if (existing.has(owner)) {
      totals.existing++;
      continue;
    }
    console.log(`  [orphan owner] ${owner}: owns sites but has no users/ doc`);
    candidates.push(owner);
  }

  let pending = [];
  for (const uid of candidates) {
    console.log(`  [${dryRun ? 'would create' : 'create'}] customers/${uid}`);

    if (dryRun) {
      totals.created++;
      continue;
    }

    pending.push({
      ref: db.collection('customers').doc(uid),
      data: backfillCustomerDoc(),
    });
    if (pending.length >= BATCH_SIZE) {
      totals.created += await commitCreates(db, pending);
      pending = [];
    }
  }

  if (!dryRun && pending.length > 0) {
    totals.created += await commitCreates(db, pending);
  }

  console.log(`\nTotals:`);
  console.log(`  ${dryRun ? 'Would create' : 'Created     '}: ${totals.created}`);
  console.log(`  Already had doc  : ${totals.existing}`);
  console.log(`  Soft-deleted     : ${totals.deleted} (skipped)`);
  console.log(`  Orphan owners    : ${totals.orphanOwners} (site owner, no users/ doc)`);
  console.log(`  User docs        : ${usersSnap.size}`);
  console.log(`  Site docs        : ${sitesSnap.size}`);

  if (dryRun && totals.created > 0) {
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
  } else if (!dryRun && totals.created > 0) {
    console.log(`\n✅ Backfill complete.`);
  } else {
    console.log(`\nNothing to backfill — every account already has a customers doc.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Backfill failed:', err);
    process.exit(1);
  });
