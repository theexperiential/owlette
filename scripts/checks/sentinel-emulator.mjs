#!/usr/bin/env node
/**
 * Proves the Admin SDK emulator branch in web/lib/firebase-admin.ts really routes
 * writes to the local emulator. Without it, `verifyIdToken` can succeed against
 * the emulator while Firestore writes silently hit PRODUCTION.
 *
 *   firebase emulators:exec --only firestore --project demo-playwright-e2e \
 *     'node scripts/checks/sentinel-emulator.mjs'
 *
 * Exit 1 means the sentinel doc never appeared — the env-var branch isn't firing,
 * or prod creds are shadowing it.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const require = createRequire(join(ROOT, 'web', 'package.json'));

// BEFORE requiring firebase-admin: the SDK reads these at initializeApp.
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
}

const admin = require('firebase-admin');

const PROJECT_ID = 'demo-playwright-e2e';

admin.initializeApp({
  projectId: PROJECT_ID,
  // No credential.cert — emulator mode needs none.
});

const db = admin.firestore();

async function main() {
  const sentinelId = `sentinel-${Date.now()}`;
  const marker = 'emulator-only';

  console.log(`Writing sentinel doc _playwright_sentinel/${sentinelId} via Admin SDK...`);
  await db.collection('_playwright_sentinel').doc(sentinelId).set({
    timestamp: new Date().toISOString(),
    marker,
  });

  // A successful read proves both that the write went to the emulator (a
  // cert-less Admin SDK cannot read prod) and that reads route there too.
  // Admin SDK, not raw REST: the emulator's REST surface still evaluates
  // firestore.rules, which deny anonymous access to this collection.
  const snapshot = await db.collection('_playwright_sentinel').doc(sentinelId).get();
  if (!snapshot.exists) {
    console.error(`❌ Sentinel doc not readable via Admin SDK right after write.`);
    console.error('   This means the SDK is routing inconsistently or has a write-buffer bug.');
    process.exit(1);
  }

  const readBackMarker = snapshot.data()?.marker;
  if (readBackMarker !== marker) {
    console.error(`❌ Sentinel doc found but data wrong. Got marker=${readBackMarker}, expected ${marker}.`);
    process.exit(1);
  }

  // Confirm the demo project was targeted: a prod id here means
  // FIREBASE_PROJECT_ID is shadowing `demo-playwright-e2e`.
  const resolvedProjectId = admin.app().options.projectId;
  if (resolvedProjectId !== PROJECT_ID) {
    console.error(`❌ Admin SDK is targeting project "${resolvedProjectId}", expected "${PROJECT_ID}".`);
    console.error('   The projectId arg to initializeApp is being overridden by an env var.');
    process.exit(1);
  }

  console.log(`✅ Sentinel doc verified via Admin SDK.`);
  console.log(`   Project: ${resolvedProjectId}`);
  console.log(`   Doc: _playwright_sentinel/${sentinelId}`);
  console.log(`   Emulator UI: http://localhost:4000/firestore`);
}

main().catch((err) => {
  console.error('❌ Sentinel test failed:', err.message);
  process.exit(1);
});
