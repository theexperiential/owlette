/**
 * nightly directory sync — publish only when content changed.
 *
 * Mirrors docs/api/examples/nightly-sync.md. The SDK's push() is already
 * content-addressed end-to-end: when nothing has changed every chunk hash
 * already exists in r2, `stats.uploadedChunks === 0`, and the server
 * short-circuits to return the existing version id without writing a new
 * one. This script just reports that cleanly and skips the deploy.
 *
 * Run from cron / systemd:
 *   0 3 * * *  node /opt/roost/nightly-sync.js
 *
 * Required env vars:
 *   ROOST_TOKEN, ROOST_SITE_ID, ROOST_ID, WATCH_DIR
 * Optional:
 *   ALERT_WEBHOOK — slack incoming-webhook url for quota alerts
 */

import { Roost, RoostApiError } from '../src/index.js';

const {
  ROOST_TOKEN, ROOST_SITE_ID, ROOST_ID, WATCH_DIR,
  ROOST_BASE = 'https://owlette.app',
  ALERT_WEBHOOK,
} = process.env;

for (const k of ['ROOST_TOKEN', 'ROOST_SITE_ID', 'ROOST_ID', 'WATCH_DIR']) {
  if (!process.env[k]) { console.error(`fatal: missing env var ${k}`); process.exit(1); }
}

const roost = new Roost({ token: ROOST_TOKEN!, apiUrl: ROOST_BASE });

async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  await fetch(ALERT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

try {
  const before = await roost.roosts.get(ROOST_ID!, { siteId: ROOST_SITE_ID! });
  const previousVersionId = before.currentVersion?.versionId ?? null;

  const result = await roost.roosts.push(WATCH_DIR!, ROOST_ID!, { siteId: ROOST_SITE_ID! });

  if (result.versionId === previousVersionId) {
    console.log(JSON.stringify({ level: 'info', msg: 'no-op — nothing changed', versionId: result.versionId }));
    process.exit(0);
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'published new version',
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    previousVersionId,
    uploadedChunks: result.stats.uploadedChunks,
    totalBytes: result.stats.totalBytes,
  }));
  process.exit(0);
} catch (err) {
  if (err instanceof RoostApiError && err.code === 'quota_exceeded') {
    await alert(`roost nightly-sync: quota exceeded for site ${ROOST_SITE_ID}`);
    console.error(JSON.stringify({ level: 'error', code: 'quota_exceeded', requestId: err.requestId }));
    process.exit(2);
  }
  console.error(JSON.stringify({ level: 'error', msg: String(err) }));
  process.exit(1);
}
