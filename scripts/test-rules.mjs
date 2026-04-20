#!/usr/bin/env node
/**
 * Firestore Rules Matrix Test — three-role permission model
 *
 * Exercises the member / admin / superadmin read-write matrix against the
 * permission-model-split rules (waves 0.2.1–0.2.3). Designed to be run via
 * firebase emulators:exec so the emulator lifecycle is managed for us:
 *
 *   firebase emulators:exec --only firestore --project demo-permission-split \
 *     'node scripts/test-rules.mjs'
 *
 * Seeds:
 *   users/member-uid   { role: 'member',     sites: ['site-A'] }
 *   users/admin-uid    { role: 'admin',      sites: ['site-A'] }
 *   users/super-uid    { role: 'superadmin', sites: [] }
 *   sites/site-A       { owner: 'someone-else' }
 *   sites/site-B       { owner: 'someone-else' }
 *
 * Prints PASS/FAIL per case and exits non-zero on any matrix divergence from
 * the plan's success criteria.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const require = createRequire(join(ROOT, 'web', 'package.json'));
const rulesUnit = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');

const { initializeTestEnvironment, assertFails, assertSucceeds } = rulesUnit;

// ---- setup ------------------------------------------------------------------

const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');

const env = await initializeTestEnvironment({
  projectId: 'demo-permission-split',
  firestore: {
    rules,
    host: '127.0.0.1',
    port: 8080,
  },
});

// Seed data bypassing rules.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users/member-uid'), {
    email: 'member@example.com',
    role: 'member',
    sites: ['site-A'],
  });
  await setDoc(doc(db, 'users/admin-uid'), {
    email: 'admin@example.com',
    role: 'admin',
    sites: ['site-A'],
  });
  await setDoc(doc(db, 'users/super-uid'), {
    email: 'super@example.com',
    role: 'superadmin',
    sites: [],
  });
  await setDoc(doc(db, 'sites/site-A'), { owner: 'someone-else', name: 'Site A' });
  await setDoc(doc(db, 'sites/site-B'), { owner: 'someone-else', name: 'Site B' });
});

const memberDb = env.authenticatedContext('member-uid').firestore();
const adminDb = env.authenticatedContext('admin-uid').firestore();
const superDb = env.authenticatedContext('super-uid').firestore();

// ---- matrix -----------------------------------------------------------------

const results = [];

async function check(name, expected, op) {
  try {
    if (expected === 'succeed') await assertSucceeds(op());
    else await assertFails(op());
    results.push({ name, outcome: 'PASS' });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, outcome: 'FAIL', error: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

console.log('\n=== member ===');
await check(
  'member reads site in their sites[]',
  'succeed',
  () => getDoc(doc(memberDb, 'sites/site-A'))
);
await check(
  'member reads site NOT in their sites[]',
  'fail',
  () => getDoc(doc(memberDb, 'sites/site-B'))
);
await check(
  'member reads own user doc',
  'succeed',
  () => getDoc(doc(memberDb, 'users/member-uid'))
);
await check(
  'member reads another user doc',
  'fail',
  () => getDoc(doc(memberDb, 'users/admin-uid'))
);
await check(
  'member writes installer_metadata (platform)',
  'fail',
  () => setDoc(doc(memberDb, 'installer_metadata/latest'), { v: '1.0' })
);
await check(
  'member writes sites/site-A/settings (site admin gate)',
  'fail',
  () => setDoc(doc(memberDb, 'sites/site-A/settings/config'), { x: 1 })
);

console.log('\n=== admin (site-scoped on site-A) ===');
await check(
  'admin reads site in their sites[]',
  'succeed',
  () => getDoc(doc(adminDb, 'sites/site-A'))
);
await check(
  'admin reads site NOT in their sites[]',
  'fail',
  () => getDoc(doc(adminDb, 'sites/site-B'))
);
await check(
  'admin writes sites/site-A/settings (site admin scope)',
  'succeed',
  () => setDoc(doc(adminDb, 'sites/site-A/settings/config'), { x: 1 })
);
await check(
  'admin writes sites/site-B/settings (unassigned)',
  'fail',
  () => setDoc(doc(adminDb, 'sites/site-B/settings/config'), { x: 1 })
);
await check(
  'admin writes installer_metadata (platform)',
  'fail',
  () => setDoc(doc(adminDb, 'installer_metadata/latest'), { v: '1.0' })
);
await check(
  'admin writes another user doc (platform)',
  'fail',
  () => setDoc(doc(adminDb, 'users/member-uid'), { role: 'admin' })
);

console.log('\n=== superadmin ===');
await check(
  'superadmin reads site in their sites[]',
  'succeed',
  () => getDoc(doc(superDb, 'sites/site-A'))
);
await check(
  'superadmin reads site NOT in their sites[] (god-mode)',
  'succeed',
  () => getDoc(doc(superDb, 'sites/site-B'))
);
await check(
  'superadmin writes installer_metadata (platform)',
  'succeed',
  () => setDoc(doc(superDb, 'installer_metadata/latest'), { v: '1.0' })
);
await check(
  'superadmin writes another user doc (platform)',
  'succeed',
  () => setDoc(doc(superDb, 'users/member-uid'), {
    email: 'member@example.com',
    role: 'admin',
    sites: ['site-A'],
  })
);
await check(
  'superadmin writes sites/site-B/settings (unassigned, god-mode)',
  'succeed',
  () => setDoc(doc(superDb, 'sites/site-B/settings/config'), { x: 1 })
);

// ---- teardown ---------------------------------------------------------------

await env.cleanup();

const failed = results.filter((r) => r.outcome === 'FAIL');
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
  (failed.length ? `, ${failed.length} failed` : '')
);

process.exit(failed.length > 0 ? 1 : 0);
