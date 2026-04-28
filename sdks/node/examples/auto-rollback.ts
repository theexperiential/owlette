/**
 * auto-rollback on `deployment.failed` webhook.
 *
 * Mirrors docs/api/examples/auto-rollback.md. Runs as a tiny node http
 * server that verifies the Roost-Signature hmac, calls rollback for the
 * offending roost, and pings slack. Deploy behind nginx / cloudflare /
 * vercel — the handler is framework-free on purpose.
 *
 * Required env vars:
 *   ROOST_TOKEN            — roost:<id>:rollback scope
 *   ROOST_SIGNING_SECRET   — whsec_* returned by webhooks.subscribe()
 *   SLACK_WEBHOOK_URL      — slack incoming webhook
 *   AUTO_ROLLBACK_SITE_IDS — comma-separated allowlist
 */

import http from 'node:http';
import { Roost, RoostApiError, verifySignature } from '@owlette/sdk';

const {
  ROOST_TOKEN, ROOST_SIGNING_SECRET, SLACK_WEBHOOK_URL, AUTO_ROLLBACK_SITE_IDS,
  ROOST_BASE = 'https://owlette.app',
  PORT = '8080',
} = process.env;

for (const k of ['ROOST_TOKEN', 'ROOST_SIGNING_SECRET', 'SLACK_WEBHOOK_URL', 'AUTO_ROLLBACK_SITE_IDS']) {
  if (!process.env[k]) { console.error(`fatal: missing env var ${k}`); process.exit(1); }
}

const allowedSites = new Set(AUTO_ROLLBACK_SITE_IDS!.split(',').map((s) => s.trim()));
const roost = new Roost({ token: ROOST_TOKEN!, apiUrl: ROOST_BASE });

async function slack(text: string): Promise<void> {
  await fetch(SLACK_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/roost') { res.statusCode = 404; res.end(); return; }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');

  const headerRaw = req.headers['roost-signature'];
  const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const verdict = verifySignature(header, raw, ROOST_SIGNING_SECRET!);
  if (!verdict.ok) {
    console.warn(`[auto-rollback] rejected ${verdict.reason}`);
    res.statusCode = 401; res.end(verdict.reason ?? 'bad_signature'); return;
  }

  const evt = JSON.parse(raw) as { type: string; data?: { siteId?: string; roostId?: string; failedVersionId?: string } };
  if (evt.type !== 'deployment.failed') { res.statusCode = 204; res.end(); return; }

  const { siteId, roostId, failedVersionId } = evt.data ?? {};
  if (!siteId || !roostId || !allowedSites.has(siteId)) {
    console.warn(`[auto-rollback] skipped site=${siteId} roost=${roostId} (not in allowlist)`);
    res.statusCode = 204; res.end(); return;
  }

  try {
    const result = await roost.roosts.rollback(roostId, { siteId });
    console.log(`[auto-rollback] ok roost=${roostId} reverted ${failedVersionId} → ${result.currentVersionId}`);
    await slack(`:rewind: auto-rollback fired for *${roostId}* on *${siteId}* — reverted \`${failedVersionId}\` → \`${result.currentVersionId}\``);
    res.statusCode = 200; res.end('{"ok":true}');
  } catch (err) {
    const detail = err instanceof RoostApiError ? `${err.status} ${err.code}` : String(err);
    console.error(`[auto-rollback] rollback failed roost=${roostId}: ${detail}`);
    await slack(`:rotating_light: auto-rollback FAILED for *${roostId}* — ${detail}`);
    res.statusCode = 502; res.end('rollback failed');
  }
}).listen(Number(PORT), () => console.log(`[auto-rollback] listening on :${PORT}`));
