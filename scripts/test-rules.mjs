#!/usr/bin/env node
/**
 * Firestore Rules Matrix Test — three-role permission model
 *
 * Exercises the full member / admin / superadmin matrix against every
 * collection the permission-model-split touched (waves 0.2.1–0.2.3):
 *
 *   - sites/{siteId}                          read gated by canAccessSite
 *   - sites/{siteId}/settings/{settingId}     read canAccessSite, write isSiteAdmin
 *   - sites/{siteId}/webhooks/{webhookId}     read canAccessSite, write isSiteAdmin
 *   - users/{userId}                          read self|superadmin, write superadmin,
 *                                             self-update allowed but role/email/sites frozen
 *   - installer_metadata/{doc}                read public, write isSuperadmin
 *   - system_presets/{presetId}               read authenticated, write isSuperadmin
 *
 * Run via firebase emulators:exec so the emulator lifecycle is managed:
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
 * Exits non-zero on any divergence from the plan's success criteria.
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

const MEMBER_DOC = {
  email: 'member@example.com',
  role: 'member',
  sites: ['site-A'],
};
const ADMIN_DOC = {
  email: 'admin@example.com',
  role: 'admin',
  sites: ['site-A'],
};
const SUPER_DOC = {
  email: 'super@example.com',
  role: 'superadmin',
  sites: [],
};

// Seed data bypassing rules.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users/member-uid'), MEMBER_DOC);
  await setDoc(doc(db, 'users/admin-uid'), ADMIN_DOC);
  await setDoc(doc(db, 'users/super-uid'), SUPER_DOC);
  await setDoc(doc(db, 'sites/site-A'), { owner: 'someone-else', name: 'Site A' });
  await setDoc(doc(db, 'sites/site-B'), { owner: 'someone-else', name: 'Site B' });
});

const memberDb = env.authenticatedContext('member-uid').firestore();
const adminDb = env.authenticatedContext('admin-uid').firestore();
const superDb = env.authenticatedContext('super-uid').firestore();
const anonDb = env.unauthenticatedContext().firestore();

// ---- matrix helpers ---------------------------------------------------------

const results = [];

async function pass(name, op) {
  try {
    await assertSucceeds(op());
    results.push({ name, outcome: 'PASS' });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, outcome: 'FAIL', error: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

async function fail(name, op) {
  try {
    await assertFails(op());
    results.push({ name, outcome: 'PASS' });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, outcome: 'FAIL', error: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

// ---- matrix -----------------------------------------------------------------

console.log('\n=== sites/{siteId} — baseline site access (canAccessSite) ===');
await pass('member reads site-A (assigned)',         () => getDoc(doc(memberDb, 'sites/site-A')));
await fail('member reads site-B (unassigned)',       () => getDoc(doc(memberDb, 'sites/site-B')));
await pass('admin reads site-A (assigned)',          () => getDoc(doc(adminDb,  'sites/site-A')));
await fail('admin reads site-B (unassigned)',        () => getDoc(doc(adminDb,  'sites/site-B')));
await pass('superadmin reads site-A',                () => getDoc(doc(superDb,  'sites/site-A')));
await pass('superadmin reads site-B (god-mode)',     () => getDoc(doc(superDb,  'sites/site-B')));

console.log('\n=== sites/{siteId}/settings/{settingId} — site-scoped read + admin write ===');
await pass('member reads settings on site-A',        () => getDoc(doc(memberDb, 'sites/site-A/settings/config')));
await fail('member reads settings on site-B',        () => getDoc(doc(memberDb, 'sites/site-B/settings/config')));
await fail('member writes settings on site-A',       () => setDoc(doc(memberDb, 'sites/site-A/settings/config'), { x: 1 }));
await pass('admin reads settings on site-A',         () => getDoc(doc(adminDb,  'sites/site-A/settings/config')));
await pass('admin writes settings on site-A',        () => setDoc(doc(adminDb,  'sites/site-A/settings/config'), { x: 1 }));
await fail('admin writes settings on site-B',        () => setDoc(doc(adminDb,  'sites/site-B/settings/config'), { x: 1 }));
await pass('superadmin reads settings on site-B',    () => getDoc(doc(superDb,  'sites/site-B/settings/config')));
await pass('superadmin writes settings on site-B',   () => setDoc(doc(superDb,  'sites/site-B/settings/config'), { x: 1 }));

console.log('\n=== sites/{siteId}/webhooks/{webhookId} — site-scoped read + admin write ===');
await pass('member reads webhook on site-A',         () => getDoc(doc(memberDb, 'sites/site-A/webhooks/w1')));
await fail('member reads webhook on site-B',         () => getDoc(doc(memberDb, 'sites/site-B/webhooks/w1')));
await fail('member writes webhook on site-A',        () => setDoc(doc(memberDb, 'sites/site-A/webhooks/w1'), { url: 'https://example.com' }));
await pass('admin reads webhook on site-A',          () => getDoc(doc(adminDb,  'sites/site-A/webhooks/w1')));
await pass('admin writes webhook on site-A',         () => setDoc(doc(adminDb,  'sites/site-A/webhooks/w1'), { url: 'https://example.com' }));
await fail('admin writes webhook on site-B',         () => setDoc(doc(adminDb,  'sites/site-B/webhooks/w1'), { url: 'https://example.com' }));
await pass('superadmin reads webhook on site-B',     () => getDoc(doc(superDb,  'sites/site-B/webhooks/w1')));
await pass('superadmin writes webhook on site-B',    () => setDoc(doc(superDb,  'sites/site-B/webhooks/w1'), { url: 'https://example.com' }));

console.log('\n=== users/{userId} — self-read + superadmin cross-user ops ===');
await pass('member reads own user doc',              () => getDoc(doc(memberDb, 'users/member-uid')));
await fail('member reads another user doc',          () => getDoc(doc(memberDb, 'users/admin-uid')));
await pass('member updates own (role preserved)',    () => setDoc(doc(memberDb, 'users/member-uid'), MEMBER_DOC));
await fail('member self-promotes to admin',          () => setDoc(doc(memberDb, 'users/member-uid'), { ...MEMBER_DOC, role: 'admin' }));
await fail('member self-promotes to superadmin',     () => setDoc(doc(memberDb, 'users/member-uid'), { ...MEMBER_DOC, role: 'superadmin' }));
await pass('admin reads own user doc',               () => getDoc(doc(adminDb,  'users/admin-uid')));
await fail('admin reads another user doc',           () => getDoc(doc(adminDb,  'users/member-uid')));
await fail('admin writes another user doc',          () => setDoc(doc(adminDb,  'users/member-uid'), { ...MEMBER_DOC, role: 'admin' }));
await pass('superadmin reads another user doc',      () => getDoc(doc(superDb,  'users/member-uid')));
await pass('superadmin writes another user doc',     () => setDoc(doc(superDb,  'users/member-uid'), { ...MEMBER_DOC, role: 'admin' }));

console.log('\n=== installer_metadata/{doc} — public read, superadmin write ===');
await pass('anon reads installer_metadata (public)', () => getDoc(doc(anonDb,   'installer_metadata/latest')));
await pass('member reads installer_metadata',        () => getDoc(doc(memberDb, 'installer_metadata/latest')));
await fail('member writes installer_metadata',       () => setDoc(doc(memberDb, 'installer_metadata/latest'), { v: '1.0' }));
await fail('admin writes installer_metadata',        () => setDoc(doc(adminDb,  'installer_metadata/latest'), { v: '1.0' }));
await pass('superadmin writes installer_metadata',   () => setDoc(doc(superDb,  'installer_metadata/latest'), { v: '1.0' }));

console.log('\n=== system_presets/{presetId} — authenticated read, superadmin write ===');
const presetDoc = {
  name: 'TouchDesigner',
  software_name: 'TouchDesigner',
  category: 'software',
  installer_name: 'TouchDesigner.exe',
  silent_flags: '/S',
  order: 1,
  createdAt: Date.now(),
};
await pass('member reads system_presets',            () => getDoc(doc(memberDb, 'system_presets/td')));
await fail('anon reads system_presets',              () => getDoc(doc(anonDb,   'system_presets/td')));
await fail('member creates system_presets',          () => setDoc(doc(memberDb, 'system_presets/td'), presetDoc));
await fail('admin creates system_presets',           () => setDoc(doc(adminDb,  'system_presets/td'), presetDoc));
await pass('superadmin creates system_presets',      () => setDoc(doc(superDb,  'system_presets/td'), presetDoc));
await pass('superadmin updates system_presets',      () => setDoc(doc(superDb,  'system_presets/td'), { ...presetDoc, order: 2 }));

// ---- teardown ---------------------------------------------------------------

await env.cleanup();

const failed = results.filter((r) => r.outcome === 'FAIL');
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
  (failed.length ? `, ${failed.length} failed` : '')
);

if (failed.length > 0) {
  console.log('\nFailed cases:');
  for (const f of failed) {
    console.log(`  - ${f.name}`);
    if (f.error) console.log(`      ${f.error.split('\n')[0]}`);
  }
}

process.exit(failed.length > 0 ? 1 : 0);
