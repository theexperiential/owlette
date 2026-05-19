#!/usr/bin/env node
/**
 * Diagnostic: dump what's actually in Firestore for roost state on dev.
 *
 *   sites/default_site/project_distributions (v1)
 *   sites/default_site/roosts                (v2)
 *   sites/default_site/machines/{machineId}/commands/pending
 *
 * Usage:  node scripts/check-roost-state.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
if (!projectId || !clientEmail || !privateKey) {
  console.error('missing FIREBASE_* env vars');
  process.exit(1);
}

const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
});
const db = admin.firestore();

const siteId = process.argv[2] || 'default_site';

console.log(`\n=== sites/${siteId}/project_distributions (v1) ===`);
const v1 = await db.collection('sites').doc(siteId).collection('project_distributions').get();
console.log(`count: ${v1.size}`);
v1.docs.slice(0, 10).forEach(d => {
  const x = d.data();
  console.log(`  ${d.id}  name="${x.name}"  status=${x.status}  targets=${(x.targets || []).length}  createdAt=${x.createdAt?.toDate?.() || '?'}`);
});

console.log(`\n=== sites/${siteId}/roosts (v2) ===`);
const v2 = await db.collection('sites').doc(siteId).collection('roosts').get();
console.log(`count: ${v2.size}`);
v2.docs.slice(0, 10).forEach(d => {
  const x = d.data();
  console.log(`  ${d.id}  name="${x.name}"  currentManifestId=${x.currentManifestId || '(none)'}  targets=${(x.targets || []).length}`);
});

console.log(`\n=== sites/${siteId}/machines (target machines) ===`);
const machines = await db.collection('sites').doc(siteId).collection('machines').get();
for (const m of machines.docs) {
  const cmds = await db.collection('sites').doc(siteId).collection('machines').doc(m.id).collection('commands').doc('pending').get();
  const pending = cmds.exists ? Object.keys(cmds.data() || {}) : [];
  console.log(`  ${m.id}  pending-commands: ${pending.length} ${pending.length ? JSON.stringify(pending.slice(0, 3)) : ''}`);
}

process.exit(0);
