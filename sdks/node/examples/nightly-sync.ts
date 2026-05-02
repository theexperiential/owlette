/**
 * Nightly directory sync: publish only when content changed.
 *
 * Required env vars:
 *   OWLETTE_TOKEN, ROOST_SITE_ID, ROOST_ID, WATCH_DIR
 *
 * Optional:
 *   ALERT_WEBHOOK - Slack incoming webhook for quota alerts.
 */

import { Owlette, OwletteApiError } from '@owlette/sdk';

const {
  OWLETTE_TOKEN, ROOST_SITE_ID, ROOST_ID, WATCH_DIR,
  OWLETTE_API_URL = 'https://owlette.app',
  ALERT_WEBHOOK,
} = process.env;

async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  await fetch(ALERT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

async function main(): Promise<number> {
  for (const k of ['OWLETTE_TOKEN', 'ROOST_SITE_ID', 'ROOST_ID', 'WATCH_DIR']) {
    if (!process.env[k]) {
      console.error(`fatal: missing env var ${k}`);
      return 1;
    }
  }

  const owlette = new Owlette({ token: OWLETTE_TOKEN!, apiUrl: OWLETTE_API_URL });

  try {
    const before = await owlette.roosts.get(ROOST_ID!, { siteId: ROOST_SITE_ID! });
    const previousVersionId = before.currentVersion?.versionId ?? null;

    const result = await owlette.roosts.push(WATCH_DIR!, ROOST_ID!, {
      siteId: ROOST_SITE_ID!,
    });

    if (result.versionId === previousVersionId) {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'no-op - nothing changed',
        versionId: result.versionId,
      }));
      return 0;
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
    return 0;
  } catch (err) {
    if (err instanceof OwletteApiError && err.code === 'quota_exceeded') {
      await alert(`roost nightly-sync: quota exceeded for site ${ROOST_SITE_ID}`);
      console.error(JSON.stringify({
        level: 'error',
        code: 'quota_exceeded',
        requestId: err.requestId,
      }));
      return 2;
    }
    console.error(JSON.stringify({ level: 'error', msg: String(err) }));
    return 1;
  }
}

main().then((code) => process.exit(code));
