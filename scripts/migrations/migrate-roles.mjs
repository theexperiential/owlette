#!/usr/bin/env node
/**
 * Migrates `users` from the two-tier role model to three tiers:
 *   'user'  → 'member'      (rename only)
 *   'admin' → 'superadmin'  (preserves current god-mode access)
 *
 * The new site-scoped `admin` tier starts empty; superadmins promote members
 * by hand. Idempotent — member/admin/superadmin are left untouched.
 *
 *   node scripts/migrations/migrate-roles.mjs --env=dev|prod [--dry-run]
 *
 * Reads FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, auto-loading
 * web/.env.local, .claude/.env.local, scripts/.env.local. CAUTION: falls back
 * to the unsuffixed vars, which point wherever web/.env.local points — verify
 * before running live against prod.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules — no root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');

// CLI parsing
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
  console.error('Usage: node scripts/migrations/migrate-roles.mjs --env=dev|prod [--dry-run]');
  process.exit(1);
}

// .env loading
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

// Credentials
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

// Migration
const ROLE_MIGRATION = Object.freeze({
  user: 'member',
  admin: 'superadmin',
});

const TERMINAL_ROLES = new Set(['member', 'admin', 'superadmin']);

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Role migration — env=${env}, project=${projectId}\n`
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

  const usersSnap = await db.collection('users').get();

  const totals = { migrated: 0, unchanged: 0, missing: 0, unknown: 0 };
  const BATCH_SIZE = 400; // Firestore caps batches at 500
  let batch = db.batch();
  let pending = 0;

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const oldRole = data.role;
    const newRole = ROLE_MIGRATION[oldRole];

    if (newRole) {
      console.log(
        `  [${dryRun ? 'would migrate' : 'migrate'}] ${doc.id}: ${oldRole} → ${newRole}`
      );
      totals.migrated++;

      if (!dryRun) {
        batch.update(doc.ref, { role: newRole });
        pending++;
        if (pending >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      }
      continue;
    }

    if (oldRole == null) {
      console.log(`  [skip] ${doc.id}: no role field`);
      totals.missing++;
    } else if (TERMINAL_ROLES.has(oldRole)) {
      totals.unchanged++;
    } else {
      console.log(`  [skip] ${doc.id}: unknown role=${JSON.stringify(oldRole)}`);
      totals.unknown++;
    }
  }

  if (!dryRun && pending > 0) {
    await batch.commit();
  }

  console.log(`\nTotals:`);
  console.log(`  ${dryRun ? 'Would migrate' : 'Migrated '}: ${totals.migrated}`);
  console.log(`  Unchanged        : ${totals.unchanged} (already member/admin/superadmin)`);
  console.log(`  Missing role     : ${totals.missing}`);
  console.log(`  Unknown role     : ${totals.unknown}`);
  console.log(`  Total docs       : ${usersSnap.size}`);

  if (dryRun && totals.migrated > 0) {
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
  } else if (!dryRun && totals.migrated > 0) {
    console.log(`\n✅ Migration complete.`);
  } else {
    console.log(`\nNothing to migrate — collection is already on the three-role model.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  });
