#!/usr/bin/env node
/**
 * Stripe Customer Backfill (billing-system wave 1.2)
 *
 * Links every `customers/{uid}` doc that has no `stripeCustomerId` to a Stripe
 * customer, and writes the id back. New accounts get theirs at signup (see
 * `web/lib/billing/stripeCustomer.server.ts`, called from
 * `bootstrapUser.server.ts`); this script covers everyone who signed up before
 * that code shipped, plus any account whose link failed — the link is
 * deliberately non-fatal to signup, so this is also the repair path.
 *
 * Run `scripts/backfill-customers.mjs` FIRST. That script creates the
 * `customers/{uid}` docs; this one only fills a field in on docs that already
 * exist. It will never create a customers doc, because a doc carrying only
 * `stripeCustomerId` would satisfy the other script's existence check and
 * permanently deny that account its trial clock and billing fields.
 *
 * ## The uid contract
 *
 * Every Stripe customer owlette creates carries `metadata.uid`. The webhook
 * handler resolves an event back to an account from that metadata first,
 * falling back to a Firestore query on `stripeCustomerId`. So:
 *   - a customer found by email that carries no `metadata.uid` gets stamped
 *     with one before we adopt it;
 *   - a customer whose `metadata.uid` names a DIFFERENT account is never
 *     adopted (that would point two accounts at one Stripe customer and the
 *     webhook would credit the wrong one) — a fresh customer is created.
 * This mirrors `linkStripeCustomer()` exactly; keep the two in step.
 *
 * Idempotent: docs that already carry a `stripeCustomerId` are skipped, the
 * email lookup reuses an existing Stripe customer rather than duplicating it,
 * and creates carry an idempotency key derived from the uid.
 *
 * Usage:
 *   node scripts/backfill-stripe-customers.mjs --env=dev --dry-run
 *   node scripts/backfill-stripe-customers.mjs --env=dev
 *   node scripts/backfill-stripe-customers.mjs --env=prod --dry-run
 *   node scripts/backfill-stripe-customers.mjs --env=prod
 *
 * Credentials:
 *   Firebase — FIREBASE_PROJECT_ID_{DEV|PROD}, FIREBASE_CLIENT_EMAIL_{DEV|PROD},
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD}, falling back to the unsuffixed
 *   web/.env.local vars (which target whatever project that file points at —
 *   verify before running live against prod).
 *
 *   Stripe — STRIPE_SECRET_KEY, falling back to STRIPE_SECRET_KEY_TEST. Same
 *   precedence as `web/lib/stripe.server.ts`. Pass a test-mode key when
 *   rehearsing; --env only selects the Firebase project, never the Stripe
 *   account.
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

// firebase-admin and stripe live in web/node_modules — resolve them from
// there so the script runs without a root-level package.json.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');
const Stripe = require('stripe');

/**
 * Stripe api version. Must match `STRIPE_API_VERSION` in
 * `web/lib/stripe.server.ts` — that file is TypeScript and can't be imported
 * from an .mjs script, so this is a hand-mirrored constant. Keep them in sync.
 */
const STRIPE_API_VERSION = '2026-07-29.dahlia';

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
    'Usage: node scripts/backfill-stripe-customers.mjs --env=dev|prod [--dry-run]'
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

// Same precedence as web/lib/stripe.server.ts. The value is never printed —
// only the derived live/test mode is.
const stripeSecret =
  process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_SECRET_KEY_TEST?.trim();

if (!stripeSecret) {
  console.error('❌ Missing Stripe credentials.');
  console.error('   Set STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY_TEST).');
  process.exit(1);
}

const stripeMode =
  stripeSecret.startsWith('sk_live_') || stripeSecret.startsWith('rk_live_')
    ? 'live'
    : 'test';

// ---- Backfill ---------------------------------------------------------------

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/** `metadata.uid` off a Stripe customer, or null when unset/empty. */
function metadataUid(customer) {
  const value = customer.metadata?.uid;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reuse the Stripe customer already carrying this email, or create one.
 *
 * Uses `customers.list({ email })` rather than `customers.search()`: search
 * runs against an index that lags writes by up to a minute, so a re-run
 * moments after a partial run could miss and duplicate. The list filter is
 * strongly consistent.
 */
async function resolveStripeCustomer(stripe, uid, email) {
  const found = await stripe.customers.list({ email, limit: 1 });
  const existing = found.data[0] ?? null;

  if (existing) {
    const ownerUid = metadataUid(existing);
    if (ownerUid === uid) return { customer: existing, action: 'reused' };
    if (ownerUid === null) {
      const stamped = await stripe.customers.update(existing.id, { metadata: { uid } });
      return { customer: stamped, action: 'adopted' };
    }
    console.warn(
      `  ⚠️  ${email} maps to stripe customer ${existing.id} owned by ${ownerUid} — creating a new one`
    );
  }

  const created = await stripe.customers.create(
    { email, metadata: { uid } },
    { idempotencyKey: `owlette-customer-${uid}` }
  );
  return { customer: created, action: 'created' };
}

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Stripe customer backfill — env=${env}, project=${projectId}, stripe=${stripeMode}\n`
  );

  if (stripeMode === 'live' && !dryRun) {
    const confirmed = await promptYesNo(
      `⚠️  Using a LIVE Stripe key — real customer objects will be created. Continue? [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

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
  const stripe = new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION });

  const [customersSnap, usersSnap] = await Promise.all([
    db.collection('customers').get(),
    db.collection('users').get(),
  ]);

  // The email to bill is the one on the user doc — the same verified address
  // bootstrap persisted from the Firebase Auth record.
  const emailByUid = new Map();
  const deletedUids = new Set();
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    if (data.deletedAt != null) deletedUids.add(doc.id);
    if (typeof data.email === 'string' && data.email.length > 0) {
      emailByUid.set(doc.id, data.email);
    }
  }

  const totals = {
    linked: 0,
    created: 0,
    reused: 0,
    adopted: 0,
    alreadyLinked: 0,
    deleted: 0,
    noEmail: 0,
    failed: 0,
  };

  for (const doc of customersSnap.docs) {
    const uid = doc.id;
    const stored = doc.data().stripeCustomerId;

    if (typeof stored === 'string' && stored.length > 0) {
      totals.alreadyLinked++;
      continue;
    }

    // Soft-deleted accounts have no live session and no fleet to bill; minting
    // a Stripe customer for one would only add an unreachable record.
    if (deletedUids.has(uid)) {
      console.log(`  [skip] ${uid}: soft-deleted account`);
      totals.deleted++;
      continue;
    }

    const email = emailByUid.get(uid);
    if (!email) {
      // Orphan owner (customers doc with no users doc) or a user doc with no
      // email. Stripe needs an address to key the idempotent lookup on, so
      // there is nothing safe to do here automatically.
      console.warn(`  ⚠️  ${uid}: no email on users/${uid} — skipped`);
      totals.noEmail++;
      continue;
    }

    if (dryRun) {
      console.log(`  [would link] customers/${uid} (${email})`);
      totals.linked++;
      continue;
    }

    try {
      const { customer, action } = await resolveStripeCustomer(stripe, uid, email);
      await doc.ref.update({ stripeCustomerId: customer.id });
      console.log(`  [${action}] customers/${uid} → ${customer.id}`);
      totals[action]++;
      totals.linked++;
    } catch (err) {
      console.error(`  ❌ ${uid}: ${err.message}`);
      totals.failed++;
    }
  }

  console.log(`\nTotals:`);
  console.log(`  ${dryRun ? 'Would link' : 'Linked    '}: ${totals.linked}`);
  if (!dryRun) {
    console.log(`    created        : ${totals.created} (new stripe customer)`);
    console.log(`    reused         : ${totals.reused} (already had metadata.uid)`);
    console.log(`    adopted        : ${totals.adopted} (existing customer, uid stamped on)`);
  }
  console.log(`  Already linked   : ${totals.alreadyLinked}`);
  console.log(`  Soft-deleted     : ${totals.deleted} (skipped)`);
  console.log(`  No email         : ${totals.noEmail} (skipped)`);
  console.log(`  Failed           : ${totals.failed}`);
  console.log(`  Customer docs    : ${customersSnap.size}`);

  if (dryRun && totals.linked > 0) {
    console.log(`\nDry run complete — no writes made. Re-run without --dry-run to apply.`);
  } else if (!dryRun && totals.failed > 0) {
    console.log(`\n⚠️  Backfill finished with ${totals.failed} failure(s) — re-run to retry.`);
  } else if (!dryRun && totals.linked > 0) {
    console.log(`\n✅ Backfill complete.`);
  } else {
    console.log(`\nNothing to backfill — every customers doc already has a stripeCustomerId.`);
  }

  // A partial run must not look like a clean one to a CI caller.
  if (!dryRun && totals.failed > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('\n❌ Backfill failed:', err);
    process.exit(1);
  });
