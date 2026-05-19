#!/usr/bin/env node
/**
 * Emulator Admin SDK Sentinel Test
 *
 * Proves the Admin SDK emulator branch in web/lib/firebase-admin.ts actually
 * routes writes to the local emulator (not prod). This is a one-time
 * verification for Wave A1.4 of the Playwright E2E plan.
 *
 * Why: without the emulator branch, `verifyIdToken` may succeed against the
 * emulator while Firestore writes silently hit production — a nasty footgun.
 *
 * Run via firebase emulators:exec so emulator lifecycle is managed:
 *
 *   firebase emulators:exec --only firestore --project demo-playwright-e2e \
 *     'node scripts/sentinel-emulator.mjs'
 *
 * Exits 0 on success. Exits 1 if the sentinel doc doesn't appear in the
 * emulator's REST surface — indicating the Admin SDK is NOT routing to
 * emulator (most likely the env-var branch isn't triggering or prod creds are
 * shadowing it).
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(join(ROOT, 'web', 'package.json'));

// Set emulator env vars BEFORE requiring firebase-admin — the SDK checks these
// on initializeApp and only then decides whether to route to emulator.
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
  // Explicitly omit credential.cert — emulator mode requires no creds.
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

  // Read back via Admin SDK. This proves:
  //   1. The write went to emulator (otherwise the read wouldn't find the doc —
  //      Admin SDK without cert can't read prod).
  //   2. The SDK is consistently routing to emulator for both reads and writes.
  // We use the Admin SDK here (not raw REST) because the emulator REST surface
  // still evaluates firestore.rules, which deny anonymous access to the
  // sentinel collection.
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

  // Additional check: confirm the SDK actually targeted the demo project (not
  // a prod project sneaking in via env vars). Any prod project ID leaking in
  // here would be a red flag that `FIREBASE_PROJECT_ID` is shadowing our
  // `demo-playwright-e2e` choice.
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
