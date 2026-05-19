#!/usr/bin/env node
/**
 * Legacy API Key Audit Script
 *
 * Enumerates API keys in Firestore and flags those that will be REJECTED
 * by the new apiAuth (Wave 1C, web v2.12.0):
 *   - keys with `scopes` missing or empty array → rejected (legacy bypass
 *     path was removed; only an explicit env-flagged allowlist resolves
 *     them, and even then `requireScope()` rejects on any scoped call)
 *   - keys with `revokedAt` set → already rejected (no action)
 *   - keys with `expiresAt` in the past → already rejected (no action)
 *   - keys with `retiresAt` in the past → already rejected (no action)
 *
 * This script is READ-ONLY. It performs no Firestore writes. There is no
 * `--apply` flag because there is nothing to apply — output is a CSV
 * (and a console summary) that you review and act on manually
 * (notify customers, revoke, or backfill scopes via the dashboard).
 *
 * Two collections are inspected:
 *   - `users/{uid}/api_keys/{keyId}` — the per-user subcollection
 *   - `api_keys/{keyHash}` — the top-level hash→key lookup table
 *
 * Subcollection is the canonical source for ownership + metadata; the
 * lookup table is what apiAuth.server.ts reads on each request. Both
 * should agree. The script reports mismatches.
 *
 * Usage:
 *   node scripts/audit-legacy-api-keys.mjs --env=dev
 *   node scripts/audit-legacy-api-keys.mjs --env=prod
 *   node scripts/audit-legacy-api-keys.mjs --env=prod --output=dev/scratch/key-audit.csv
 *
 * Credentials follow the same pattern as scripts/migrate-roles.mjs.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

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

const env = getFlag('env');
const outputPath = getFlag('output'); // optional override; defaults to dev/scratch/...

if (env !== 'dev' && env !== 'prod') {
  console.error('Usage: node scripts/audit-legacy-api-keys.mjs --env=dev|prod [--output=path.csv]');
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

// ---- Helpers ----------------------------------------------------------------

function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && typeof value.toMillis === 'function') {
    try {
      return value.toMillis();
    } catch {
      return null;
    }
  }
  return null;
}

function toIsoOrEmpty(value) {
  const ms = toMillis(value);
  if (ms == null) return '';
  return new Date(ms).toISOString();
}

function classify(keyData, now) {
  const revokedAt = toMillis(keyData.revokedAt);
  const retiresAt = toMillis(keyData.retiresAt);
  const expiresAt = toMillis(keyData.expiresAt);
  const scopes = Array.isArray(keyData.scopes) ? keyData.scopes : null;
  const hasScopes = scopes !== null && scopes.length > 0;

  // Already-handled states first (these keys aren't usable anyway).
  if (revokedAt && revokedAt <= now) return 'already_revoked';
  if (retiresAt && retiresAt <= now) return 'already_retired';
  if (expiresAt && expiresAt <= now) return 'already_expired';

  if (!hasScopes) {
    // This is the legacy-key-rejected-by-2.12.0 case.
    return 'will_be_rejected';
  }
  return 'ok_scoped';
}

function recommendation(status) {
  switch (status) {
    case 'will_be_rejected':
      return 'BACKFILL scopes OR notify customer + REVOKE. As of 2.12.0 this key returns 401.';
    case 'already_revoked':
      return 'no action — revokedAt is in the past';
    case 'already_retired':
      return 'no action — retiresAt is in the past';
    case 'already_expired':
      return 'no action — expiresAt is in the past';
    case 'ok_scoped':
      return 'no action — key has explicit scopes and will continue to work';
    default:
      return 'unknown';
  }
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log(`\nAPI key audit — env=${env}, project=${projectId}\n`);
  console.log('(read-only — no Firestore writes will occur)\n');

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  const db = admin.firestore();
  const now = Date.now();

  // Inventory subcollection (users/{uid}/api_keys/{keyId}). This collection-
  // group query reads every per-user key with its full document data.
  console.log('Querying users/{uid}/api_keys ...');
  const subSnap = await db.collectionGroup('api_keys').get();

  // Read top-level lookup table (api_keys/{keyHash}). Note: in newer schemas
  // the user-owned keys live ONLY under users/{uid}/api_keys and the
  // top-level collection is a hash → uid+keyId index. We index it by
  // (userId, keyId) so the audit can cross-check that both ends agree on
  // metadata. If your schema is different the warn at the bottom will fire.
  console.log('Querying top-level api_keys lookup table ...');
  const lookupSnap = await db.collection('api_keys').get();
  const lookupByUidKeyId = new Map();
  for (const doc of lookupSnap.docs) {
    const d = doc.data() || {};
    if (d.userId && d.keyId) {
      lookupByUidKeyId.set(`${d.userId}::${d.keyId}`, { ...d, _hash: doc.id });
    }
  }

  // Fetch the small set of user emails for the rows we'll report. We do
  // this in a second pass to keep the main scan O(keys) rather than
  // O(keys * 1-Firestore-roundtrip).
  const userIds = new Set();
  for (const doc of subSnap.docs) {
    const path = doc.ref.path; // users/{uid}/api_keys/{keyId}
    const segs = path.split('/');
    if (segs.length >= 2 && segs[0] === 'users') userIds.add(segs[1]);
  }
  console.log(`Resolving ${userIds.size} owner email(s) ...`);
  const emailByUid = new Map();
  // chunk into reads of 30 (Firestore batchGet equivalent via Promise.all)
  const uidList = [...userIds];
  const CHUNK = 30;
  for (let i = 0; i < uidList.length; i += CHUNK) {
    const slice = uidList.slice(i, i + CHUNK);
    const refs = slice.map((uid) => db.collection('users').doc(uid));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) {
      if (s.exists) {
        const d = s.data() || {};
        emailByUid.set(s.id, d.email || '');
      }
    }
  }

  // Build the report rows.
  const rows = [];
  let mismatches = 0;
  for (const doc of subSnap.docs) {
    const path = doc.ref.path;
    const segs = path.split('/');
    if (segs.length < 4 || segs[0] !== 'users' || segs[2] !== 'api_keys') continue;
    const uid = segs[1];
    const keyId = segs[3];
    const d = doc.data() || {};
    const status = classify(d, now);

    // Cross-check the lookup-table copy (if present).
    const lookup = lookupByUidKeyId.get(`${uid}::${keyId}`);
    const lookupStatus = lookup ? classify(lookup, now) : null;
    const mismatched = lookup && status !== lookupStatus;
    if (mismatched) mismatches++;

    rows.push({
      uid,
      keyId,
      email: emailByUid.get(uid) || '',
      name: d.name || '',
      environment: d.environment || '',
      scopes_count: Array.isArray(d.scopes) ? d.scopes.length : 0,
      scopes_value: Array.isArray(d.scopes) ? d.scopes.join('|') : '',
      created_at: toIsoOrEmpty(d.createdAt),
      last_used_at: toIsoOrEmpty(d.lastUsedAt),
      revoked_at: toIsoOrEmpty(d.revokedAt),
      retires_at: toIsoOrEmpty(d.retiresAt),
      expires_at: toIsoOrEmpty(d.expiresAt),
      status,
      lookup_status: lookupStatus || 'no_lookup_doc',
      mismatched: mismatched ? 'yes' : '',
      recommendation: recommendation(status),
    });
  }

  // Summary
  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n=== Summary ===`);
  console.log(`  Total api_keys subcollection docs : ${subSnap.size}`);
  console.log(`  Total api_keys lookup-table docs  : ${lookupSnap.size}`);
  console.log(`  Mismatched sub vs lookup          : ${mismatches}`);
  console.log(`  Status breakdown:`);
  for (const [status, count] of Object.entries(counts).sort()) {
    console.log(`    ${status.padEnd(20)} : ${count}`);
  }

  const willReject = rows.filter((r) => r.status === 'will_be_rejected');
  if (willReject.length > 0) {
    console.log(`\n⚠️  ${willReject.length} key(s) will be REJECTED by 2.12.0+:`);
    for (const r of willReject) {
      console.log(
        `    keyId=${r.keyId.padEnd(20)} owner=${r.email || r.uid} ` +
          `name="${r.name}" last_used=${r.last_used_at || '(never)'}`,
      );
    }
  } else {
    console.log(`\n✅ No keys will be rejected — all active keys have explicit scopes.`);
  }

  // CSV output
  const defaultOut = join(ROOT, 'dev', 'scratch', `key-audit-${env}-${Date.now()}.csv`);
  const outPath = outputPath ? join(ROOT, outputPath) : defaultOut;
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const headers = [
    'uid',
    'keyId',
    'email',
    'name',
    'environment',
    'scopes_count',
    'scopes_value',
    'created_at',
    'last_used_at',
    'revoked_at',
    'retires_at',
    'expires_at',
    'status',
    'lookup_status',
    'mismatched',
    'recommendation',
  ];
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
  ].join('\n');
  writeFileSync(outPath, csv);
  console.log(`\nFull report written to: ${outPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Audit failed:', err);
    process.exit(1);
  });
