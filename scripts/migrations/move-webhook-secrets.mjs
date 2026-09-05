#!/usr/bin/env node
/**
 * Move webhook signing secrets out of the client-readable webhook document.
 *
 * `sites/{siteId}/webhooks/{webhookId}` is readable by any site MEMBER
 * (`canAccessSite` in firestore.rules, no role term) and carried `signingSecret`,
 * `previousSigningSecret` and the legacy `secret`. Any member could therefore read
 * the HMAC secret and forge deliveries the customer's receiver would validate as
 * authentic. firestore.rules named this in its `talon_secrets` block and it stayed
 * live regardless.
 *
 * Secrets now live at `sites/{siteId}/webhook_secrets/{webhookId}`, which is
 * `allow read, write: if false` — Admin SDK only. This script copies them across
 * and then strips the three fields from the webhook document.
 *
 * Two phases so a failure never destroys the only copy:
 *   --copy    write the sibling documents; webhook docs untouched. Idempotent.
 *   --strip   delete the fields from the webhook docs, ONLY where the sibling
 *             already holds a matching secret. Idempotent. Run after --copy has
 *             been verified and the reading code is deployed.
 * Running neither performs a dry run and reports what each phase would do.
 *
 * The server code reads the sibling first and falls back to the in-document value,
 * so --copy is safe to run before deploy and --strip safe to run after.
 *
 * Usage:
 *   node scripts/migrations/move-webhook-secrets.mjs --env=dev
 *   node scripts/migrations/move-webhook-secrets.mjs --env=dev --copy
 *   node scripts/migrations/move-webhook-secrets.mjs --env=prod --copy --confirm-project=owlette-prod-90a12
 *   node scripts/migrations/move-webhook-secrets.mjs --env=prod --strip --confirm-project=owlette-prod-90a12
 *
 * Credentials: FIREBASE_{PROJECT_ID,CLIENT_EMAIL,PRIVATE_KEY}_{DEV|PROD}, falling
 * back to the unsuffixed vars, loaded from web/.env.local, .claude/.env.local or
 * scripts/.env.local. Verify the printed project id before a live run.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// firebase-admin lives in web/node_modules. Modular entry points — the root
// namespace no longer exports .credential/.firestore.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
function getFlag(name) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

const env = getFlag('env') === 'prod' ? 'prod' : 'dev';
const doCopy = getFlag('copy') === true;
const doStrip = getFlag('strip') === true;
const confirmProject = getFlag('confirm-project');

if (doCopy && doStrip) {
  console.error('❌ pass --copy or --strip, not both: strip must follow a verified copy.');
  process.exit(1);
}

for (const f of [
  join(ROOT, 'web', '.env.local'),
  join(ROOT, '.claude', '.env.local'),
  join(ROOT, 'scripts', '.env.local'),
]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const SUF = env === 'prod' ? '_PROD' : '_DEV';
const projectId = process.env[`FIREBASE_PROJECT_ID${SUF}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${SUF}`] || process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (
  process.env[`FIREBASE_PRIVATE_KEY${SUF}`] || process.env.FIREBASE_PRIVATE_KEY || ''
).replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error(`❌ Missing Firebase credentials for env=${env} (need FIREBASE_*${SUF}).`);
  process.exit(1);
}

const live = doCopy || doStrip;
const phase = doCopy ? 'COPY' : doStrip ? 'STRIP' : 'DRY RUN';

async function confirm(question) {
  if (confirmProject) {
    if (confirmProject !== projectId) {
      console.error(`❌ --confirm-project=${confirmProject} does not match ${projectId}.`);
      process.exit(1);
    }
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim() === projectId;
}

initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
const db = getFirestore();

const SECRET_FIELDS = ['signingSecret', 'previousSigningSecret', 'secret'];

async function main() {
  console.log(`\n[${phase}] Webhook signing-secret relocation — env=${env}, project=${projectId}\n`);

  if (live) {
    const ok = await confirm(`Type the project id to proceed (${projectId}): `);
    if (!ok) {
      console.error('❌ confirmation did not match; aborting.');
      process.exit(1);
    }
  }

  const sites = await db.collection('sites').get();
  const plan = [];

  for (const site of sites.docs) {
    const hooks = await site.ref.collection('webhooks').get();
    for (const hook of hooks.docs) {
      const data = hook.data() || {};
      const inDoc = {
        signingSecret: typeof data.signingSecret === 'string' ? data.signingSecret : null,
        previousSigningSecret:
          typeof data.previousSigningSecret === 'string' ? data.previousSigningSecret : null,
        legacy: typeof data.secret === 'string' ? data.secret : null,
      };
      const hasAny = Boolean(inDoc.signingSecret || inDoc.previousSigningSecret || inDoc.legacy);

      const siblingSnap = await site.ref
        .collection('webhook_secrets')
        .doc(hook.id)
        .get();
      const sibling = siblingSnap.exists ? siblingSnap.data() || {} : null;

      plan.push({
        siteId: site.id,
        webhookId: hook.id,
        hasAny,
        // Prefer the explicit current secret; fall back to the legacy field name.
        current: inDoc.signingSecret || inDoc.legacy,
        previous: inDoc.previousSigningSecret,
        siblingHasSecret: typeof sibling?.signingSecret === 'string' && !!sibling.signingSecret,
        siblingMatches:
          typeof sibling?.signingSecret === 'string' &&
          sibling.signingSecret === (inDoc.signingSecret || inDoc.legacy),
      });
    }
  }

  const toCopy = plan.filter((p) => p.hasAny && !p.siblingHasSecret && p.current);
  // Strip ONLY where the sibling holds the same secret the document does. A
  // rotation between --copy and --strip legitimately changes the sibling, and
  // stripping on "a sibling exists" alone would destroy the last copy of a key
  // that no longer matches. Mismatches are reported and skipped, not guessed at.
  const toStrip = plan.filter((p) => p.hasAny && p.siblingHasSecret && p.siblingMatches);
  const mismatched = plan.filter((p) => p.hasAny && p.siblingHasSecret && !p.siblingMatches);
  const stranded = plan.filter((p) => p.hasAny && !p.current);

  console.log(`webhooks scanned            : ${plan.length}`);
  console.log(`carrying an in-document key : ${plan.filter((p) => p.hasAny).length}`);
  console.log(`already copied to sibling   : ${plan.filter((p) => p.siblingHasSecret).length}`);
  console.log(`--copy would write          : ${toCopy.length}`);
  console.log(`--strip would clear         : ${toStrip.length}`);
  if (mismatched.length) {
    console.log(
      `
⚠️  ${mismatched.length} webhook(s) have a sibling secret that DIFFERS from the ` +
        `in-document one (rotated since --copy). Skipped by --strip; re-run --copy is not enough — ` +
        `confirm which key the receiver expects before clearing these by hand.`,
    );
    for (const p of mismatched) console.log(`     ${p.siteId}/${p.webhookId}`);
  }

  if (stranded.length) {
    console.log(
      `\n⚠️  ${stranded.length} webhook(s) carry only a previousSigningSecret with no current secret; ` +
        `they are left alone — rotate them.`,
    );
    for (const p of stranded) console.log(`     ${p.siteId}/${p.webhookId}`);
  }

  if (!live) {
    console.log('\n[DRY RUN] no writes performed. Re-run with --copy, then --strip.\n');
    return;
  }

  const logPath = join(__dirname, `move-webhook-secrets.${projectId}.log.json`);
  const changes = [];

  if (doCopy) {
    for (const p of toCopy) {
      // create(), not set(): a rotation landing between the scan above and this
      // write already produced a sibling, and set() would overwrite the NEW key
      // with the stale one — every later delivery then signed with a secret the
      // receiver rejects. Losing the race is a skip, not a clobber.
      try {
        await db
          .collection('sites')
          .doc(p.siteId)
          .collection('webhook_secrets')
          .doc(p.webhookId)
          .create({
            signingSecret: p.current,
            previousSigningSecret: p.previous ?? null,
            updatedAt: FieldValue.serverTimestamp(),
          });
        changes.push({ op: 'copy', siteId: p.siteId, webhookId: p.webhookId });
        console.log(`  copied ${p.siteId}/${p.webhookId}`);
      } catch (err) {
        if (err && err.code === 6) {
          console.log(`  skipped ${p.siteId}/${p.webhookId} — sibling appeared mid-run (rotation?)`);
          continue;
        }
        throw err;
      }
    }
    console.log(`\n✅ copied ${changes.length} secret(s). Verify, deploy, then run --strip.`);
  }

  if (doStrip) {
    for (const p of toStrip) {
      const patch = {};
      for (const f of SECRET_FIELDS) patch[f] = FieldValue.delete();
      await db
        .collection('sites')
        .doc(p.siteId)
        .collection('webhooks')
        .doc(p.webhookId)
        .update(patch);
      changes.push({ op: 'strip', siteId: p.siteId, webhookId: p.webhookId });
      console.log(`  stripped ${p.siteId}/${p.webhookId}`);
    }
    console.log(`\n✅ stripped ${changes.length} webhook document(s).`);
  }

  writeFileSync(
    logPath,
    JSON.stringify({ projectId, phase, changes }, null, 2),
    'utf8',
  );
  console.log(`log: ${logPath}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('❌ migration failed:', err);
    process.exit(1);
  },
);
