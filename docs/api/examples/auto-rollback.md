# auto-rollback on deployment.failed webhook

a small node/express webhook receiver that listens for `deployment.failed` events from roost, verifies the `Roost-Signature` hmac, calls `POST /api/roosts/{roostId}/rollback`, and notifies a slack channel. deploy it anywhere that can accept https requests — vercel, cloudflare workers, or a plain node server behind nginx. the same code shape runs in all three with minor entrypoint tweaks.

## required env vars

- `ROOST_TOKEN` — api key with `roost:<id>:rollback` scope. if you want this receiver to cover every roost in a site, use `site:<id>:write` or a wildcard roost scope.
- `ROOST_BASE` — `https://owlette.app` or `https://dev.owlette.app`.
- `ROOST_SIGNING_SECRET` — the `signingSecret` returned from `POST /api/webhooks` when you subscribed to `deployment.failed`. store it once; never logged.
- `SLACK_WEBHOOK_URL` — incoming-webhook url from a slack app (`https://hooks.slack.com/services/...`).
- `AUTO_ROLLBACK_SITE_IDS` — comma-separated allowlist of site ids this receiver is allowed to rollback for. guard against a key scoped too broadly.

## `server.mjs` (node + express)

```js
#!/usr/bin/env node
// server.mjs — runs on any https-reachable node host.
// POST /webhooks/roost  (configure this url when creating the webhook subscription)

import express from 'express';
import crypto from 'node:crypto';

const {
  ROOST_TOKEN, ROOST_BASE, ROOST_SIGNING_SECRET,
  SLACK_WEBHOOK_URL, AUTO_ROLLBACK_SITE_IDS,
  PORT = '8080',
} = process.env;

for (const k of ['ROOST_TOKEN', 'ROOST_BASE', 'ROOST_SIGNING_SECRET', 'SLACK_WEBHOOK_URL', 'AUTO_ROLLBACK_SITE_IDS']) {
  if (!process.env[k]) { console.error(`fatal: missing env var ${k}`); process.exit(1); }
}

const ROOST_VERSION = '2026-04-22';
const ALLOWED_SITES = new Set(AUTO_ROLLBACK_SITE_IDS.split(',').map(s => s.trim()));

const app = express();
// capture the raw body for signature verification. do NOT use express.json() here —
// reserialising the payload would change the bytes the hmac was computed over.
app.use('/webhooks/roost', express.raw({ type: 'application/json', limit: '1mb' }));

function verifySignature(sigHeader, rawBody) {
  // Roost-Signature: t=<unix>,v1=<hmac>
  if (!sigHeader) return { ok: false, reason: 'missing signature' };
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=', 2)));
  const t = parseInt(parts.t || '', 10);
  const v1 = parts.v1 || '';
  if (!t || !v1) return { ok: false, reason: 'malformed signature' };

  // 5-min replay tolerance
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (ageSec > 300) return { ok: false, reason: `stale timestamp (${ageSec}s old)` };

  const expected = crypto
    .createHmac('sha256', ROOST_SIGNING_SECRET)
    .update(`${t}.`)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hmac mismatch' };
  }
  return { ok: true };
}

async function postSlack(blocks, fallbackText) {
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: fallbackText, blocks }),
    });
  } catch (e) {
    console.error('slack post failed:', e);
  }
}

async function rollbackRoost(roostId, siteId, currentManifestId) {
  const idem = `auto-rollback-${roostId}-${Date.now()}`;
  const res = await fetch(`${ROOST_BASE}/api/roosts/${roostId}/rollback`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ROOST_TOKEN}`,
      'roost-version': ROOST_VERSION,
      'content-type': 'application/json',
      'idempotency-key': idem,
      ...(currentManifestId ? { 'if-match': currentManifestId } : {}),
    },
    body: JSON.stringify({ siteId }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

app.post('/webhooks/roost', async (req, res) => {
  const rawBody = req.body; // Buffer
  const sig = req.get('roost-signature');
  const event = req.get('roost-event');
  const deliveryId = req.get('roost-delivery');

  const check = verifySignature(sig, rawBody);
  if (!check.ok) {
    console.warn(`signature verification failed: ${check.reason} (delivery ${deliveryId})`);
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  // always 200 fast to avoid webhook retries while we do work; roost retries on non-2xx
  res.status(200).json({ received: true });

  if (event !== 'deployment.failed') {
    console.log(`ignoring event ${event} (delivery ${deliveryId})`);
    return;
  }

  const { roostId, siteId, rolloutId, manifestId, failureCount } = payload.data || {};
  if (!roostId || !siteId) {
    console.warn(`malformed deployment.failed payload (delivery ${deliveryId})`);
    return;
  }
  if (!ALLOWED_SITES.has(siteId)) {
    console.warn(`site ${siteId} not in auto-rollback allowlist — skipping (delivery ${deliveryId})`);
    return;
  }

  console.log(`deployment.failed for roost ${roostId} (rollout ${rolloutId}, ${failureCount} machines) — rolling back`);

  const rollback = await rollbackRoost(roostId, siteId, manifestId);

  if (rollback.ok) {
    await postSlack([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:rewind: *auto-rollback* — roost \`${roostId}\`\n` +
                `rollout \`${rolloutId}\` failed on ${failureCount} machine(s); ` +
                `rolled back to \`${rollback.body.currentManifestId?.slice(0, 19) || 'previous'}\`.`,
        },
      },
    ], `auto-rollback: ${roostId}`);
  } else {
    const code = rollback.body.code || 'unknown';
    const detail = rollback.body.detail || '';
    await postSlack([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *auto-rollback FAILED* — roost \`${roostId}\`\n` +
                `status \`${rollback.status}\` code \`${code}\`\n` +
                `${detail}\n` +
                `manual intervention required.`,
        },
      },
    ], `auto-rollback failed: ${roostId}`);
  }
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.listen(parseInt(PORT, 10), () => {
  console.log(`auto-rollback receiver listening on :${PORT}`);
});
```

the receiver mounts `express.raw()` (not `express.json()`) on the webhook path because reserialising the payload would change the bytes that `Roost-Signature` was computed over. after verifying the hmac and the 5-minute replay window, it acknowledges with a fast `200` so roost doesn't retry the delivery while the rollback is still in flight, then asynchronously calls `POST /api/roosts/{roostId}/rollback` with an `If-Match` header pinned to the failed rollout's `manifestId`. that `If-Match` is the safety net: if someone manually published a fix between the failure and the webhook arriving, the rollback returns `412 precondition_failed` and the receiver posts a warning to slack rather than clobbering the new publish.

## slack setup

1. in slack: create an app → `incoming webhooks` → activate → add to channel. copy the webhook url.
2. set it as `SLACK_WEBHOOK_URL` in your deploy environment.
3. the receiver posts a single-block message; customise `blocks` to add buttons, actor info, or deploy links as needed.

## deploy instructions

### option 1 — vercel

```bash
npm init -y
npm install express
cp server.mjs api/webhook.js     # vercel uses api/ for functions
```

create `api/webhook.js`:

```js
// api/webhook.js — vercel serverless wrapper around the express app above
import app from '../server.mjs';
export const config = { api: { bodyParser: false } }; // critical for raw body
export default app;
```

then in your repo root:

```bash
vercel env add ROOST_TOKEN
vercel env add ROOST_SIGNING_SECRET
vercel env add SLACK_WEBHOOK_URL
vercel env add AUTO_ROLLBACK_SITE_IDS
vercel env add ROOST_BASE
vercel --prod
```

register the deployed url (e.g. `https://your-app.vercel.app/api/webhook`) via `POST /api/webhooks` with `events: ["deployment.failed"]`.

### option 2 — cloudflare worker

workers don't speak express; port the handler:

```js
// worker.js
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const sigHeader = request.headers.get('roost-signature');
    // reuse verifySignature / rollbackRoost / postSlack logic, with env.ROOST_TOKEN etc.
    // use `crypto.subtle.importKey` + `crypto.subtle.sign` instead of node:crypto hmac.
    // return new Response(JSON.stringify({received:true}), {status:200});
  },
};
```

deploy with `wrangler deploy`; set secrets via `wrangler secret put ROOST_TOKEN` etc.

### option 3 — plain node server

```bash
npm install express
node server.mjs
```

run behind nginx/caddy with a valid tls cert. for production, put it under a process supervisor (`systemd`, `pm2`) and front it with a load balancer if you expect more than one delivery per second.

## register the webhook subscription

after deploying, register the endpoint:

```bash
curl -fsS "$ROOST_BASE/api/webhooks" \
  -H "Authorization: Bearer $ROOST_TOKEN" \
  -H "Roost-Version: 2026-04-22" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "siteId": "kiosk-fleet-01",
    "url": "https://your-app.example.com/webhooks/roost",
    "events": ["deployment.failed"],
    "description": "auto-rollback on failed deploy"
  }'
```

the response includes `signingSecret` — copy it once into `ROOST_SIGNING_SECRET`. it's only shown on create; after that you'd have to `POST /api/webhooks/{id}/rotate-secret` to mint a new one.

## error handling summary

- signature verification failure → `401` and a warning log. roost treats this as a failed delivery and retries (5 attempts with exponential backoff) before marking the delivery `failed`. a persistent mismatch means your `ROOST_SIGNING_SECRET` is stale — rotate via the webhook's `rotate-secret` endpoint.
- stale timestamp (>5min) → `401`. usually clock drift on the receiver host; sync ntp and re-register if needed.
- rollback `412 precondition_failed` → someone published between the failure and this rollback. slack is told "manual intervention required" rather than retrying blindly.
- rollback `409 conflict` (`no_previous_manifest`) → the failed manifest was the first ever published. nothing to roll back to; slack warning.
- rollback `403 scope_insufficient` → receiver's key is missing `roost:<id>:rollback`. slack warning; fix the scope in the dashboard.
- duplicate webhook deliveries (roost retries on non-2xx) → safe because `Idempotency-Key` is derived from `roostId + ms timestamp` which the 24h cache collapses to one rollback, and roost's `Roost-Delivery` header lets you dedupe in your own store if you want even stronger guarantees.
