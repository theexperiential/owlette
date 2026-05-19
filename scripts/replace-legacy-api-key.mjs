#!/usr/bin/env node
/**
 * Replace a single legacy (empty-scope) API key with a fresh scoped key.
 *
 * Mints a new owk_<env>_<random> key with the supplied scopes, writes
 * both the per-user subcollection doc and the top-level hash → key
 * lookup doc, and sets revokedAt on the old key (both ends). The new
 * raw key is printed ONCE to stdout — paste it into the relevant env
 * file (e.g. .claude/.env.local).
 *
 * Usage:
 *   # Dry-run — prints what would happen, writes nothing:
 *   node scripts/replace-legacy-api-key.mjs --env=dev --old-key=$OWLETTE_API_KEY --scopes=installer=*:write,installer=*:read,installer=*:admin
 *
 *   # Live (writes to Firestore):
 *   node scripts/replace-legacy-api-key.mjs --env=dev --old-key=$OWLETTE_API_KEY --scopes=installer=*:write,installer=*:read,installer=*:admin --apply
 *
 * The script is READ-ONLY by default; --apply is required to mutate.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import crypto from 'crypto';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

const env = getFlag('env');
const oldKey = getFlag('old-key');
const scopesArg = getFlag('scopes');
const apply = getFlag('apply') === true;
const newKeyName = getFlag('name') || 'Replacement key (auto)';

if (env !== 'dev' && env !== 'prod') {
  console.error('Usage: node scripts/replace-legacy-api-key.mjs --env=dev|prod --old-key=owk_... --scopes=resource=id:permission[,...] [--apply] [--name="..."]');
  process.exit(1);
}
if (!oldKey || typeof oldKey !== 'string' || !oldKey.startsWith('owk_')) {
  console.error('❌ --old-key must be an owk_* key value');
  process.exit(1);
}
if (!scopesArg || typeof scopesArg !== 'string') {
  console.error('❌ --scopes is required (comma-separated, e.g. installer=*:write,installer=*:read)');
  process.exit(1);
}
const scopes = scopesArg.split(',').map((s) => s.trim()).filter(Boolean);
if (scopes.length === 0) {
  console.error('❌ --scopes parsed to empty list');
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
const projectId = process.env[`FIREBASE_PROJECT_ID${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env[`FIREBASE_CLIENT_EMAIL${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env[`FIREBASE_PRIVATE_KEY${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;
if (!projectId || !clientEmail || !rawPrivateKey) {
  console.error(`❌ Missing Firebase credentials for env=${env}.`);
  process.exit(1);
}
const privateKey = rawPrivateKey.replace(/\\n/g, '\n');

// ---- Key generation ---------------------------------------------------------

function generateKey(envLabel) {
  // Mirror the format used by the existing /api/keys mint route:
  // owk_{live|test}_<base64url(32 random bytes)>
  const tag = envLabel === 'prod' ? 'live' : 'test';
  const random = crypto.randomBytes(32).toString('base64url');
  return `owk_${tag}_${random}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log(`\n${apply ? '[APPLY]' : '[DRY RUN]'} Replace legacy API key — env=${env}, project=${projectId}`);
  console.log(`Scopes for new key: ${scopes.join(', ')}\n`);

  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  const db = admin.firestore();

  // 1. Resolve the old key.
  const oldHash = sha256(oldKey);
  const oldLookupRef = db.collection('api_keys').doc(oldHash);
  const oldLookupSnap = await oldLookupRef.get();
  if (!oldLookupSnap.exists) {
    console.error(`❌ No api_keys/{hash} doc found for the supplied --old-key (hash prefix ${oldHash.slice(0, 12)}...).`);
    process.exit(1);
  }
  const oldLookupData = oldLookupSnap.data() || {};
  const ownerUid = oldLookupData.userId;
  const oldKeyId = oldLookupData.keyId;
  if (!ownerUid || !oldKeyId) {
    console.error('❌ Old key lookup doc is missing userId/keyId — refusing to proceed.');
    process.exit(1);
  }

  const oldSubRef = db.collection('users').doc(ownerUid).collection('api_keys').doc(oldKeyId);
  const oldSubSnap = await oldSubRef.get();
  if (!oldSubSnap.exists) {
    console.error(`❌ No users/${ownerUid}/api_keys/${oldKeyId} doc — lookup table is orphaned. Aborting.`);
    process.exit(1);
  }
  const oldSubData = oldSubSnap.data() || {};

  console.log(`Old key:`);
  console.log(`  owner uid    : ${ownerUid}`);
  console.log(`  keyId        : ${oldKeyId}`);
  console.log(`  name         : ${oldSubData.name || '(none)'}`);
  console.log(`  current scopes: ${Array.isArray(oldSubData.scopes) ? (oldSubData.scopes.length ? oldSubData.scopes.join('|') : '(empty)') : '(missing field)'}`);
  console.log(`  revokedAt    : ${oldSubData.revokedAt ? 'already revoked' : 'no'}`);

  // 2. Generate the new key.
  const newRawKey = generateKey(env);
  const newHash = sha256(newRawKey);
  const newKeyId = crypto.randomUUID();

  console.log(`\nNew key plan:`);
  console.log(`  keyId        : ${newKeyId}`);
  console.log(`  name         : ${newKeyName}`);
  console.log(`  scopes       : ${scopes.join(' , ')}`);
  console.log(`  hash prefix  : ${newHash.slice(0, 12)}...`);

  if (!apply) {
    console.log(`\n[DRY RUN] No writes performed. Re-run with --apply to perform the replacement.`);
    process.exit(0);
  }

  if (env === 'prod') {
    const confirmed = await promptYesNo(`\n⚠️  About to write to PRODUCTION (${projectId}). Continue? [y/N] `);
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // 3. Transaction: write new docs + revoke old.
  await db.runTransaction(async (tx) => {
    const newSubRef = db.collection('users').doc(ownerUid).collection('api_keys').doc(newKeyId);
    const newLookupRef = db.collection('api_keys').doc(newHash);

    const newSubExists = await tx.get(newSubRef);
    const newLookupExists = await tx.get(newLookupRef);
    if (newSubExists.exists || newLookupExists.exists) {
      throw new Error('Generated keyId/hash collision — extremely unlikely; just re-run.');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // Per-user subcollection doc.
    tx.set(newSubRef, {
      keyId: newKeyId,
      userId: ownerUid,
      name: newKeyName,
      scopes,
      environment: env === 'prod' ? 'live' : 'test',
      createdAt: now,
      lastUsedAt: null,
      previousKeyId: oldKeyId,
      replacementReason: 'legacy_scope_backfill',
    });

    // Top-level hash → key lookup.
    tx.set(newLookupRef, {
      userId: ownerUid,
      keyId: newKeyId,
      scopes,
      environment: env === 'prod' ? 'live' : 'test',
      createdAt: now,
    });

    // Revoke the old key on BOTH ends so apiAuth.server.ts rejects it.
    tx.update(oldSubRef, {
      revokedAt: now,
      revokedReason: 'replaced_by_scoped_key',
      replacedByKeyId: newKeyId,
    });
    tx.update(oldLookupRef, {
      revokedAt: now,
      revokedReason: 'replaced_by_scoped_key',
      replacedByKeyId: newKeyId,
    });
  });

  console.log(`\n✅ Replacement complete.\n`);
  console.log(`================================================================`);
  console.log(`NEW KEY (paste into .claude/.env.local as OWLETTE_API_KEY${env === 'prod' ? '_PROD' : ''}=):`);
  console.log('');
  console.log(`  ${newRawKey}`);
  console.log('');
  console.log(`This is the ONLY time it will be displayed. Save it now.`);
  console.log(`================================================================\n`);
  console.log(`Old key keyId=${oldKeyId} has been revoked. It will return 401 on next use.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Replacement failed:', err);
    process.exit(1);
  });
