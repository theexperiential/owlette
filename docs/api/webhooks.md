# roost api — webhooks

webhooks are how roost tells your systems that something happened — a new manifest published, a deploy failed, a machine dropped offline, a quota alarm tripped. instead of polling the api on a timer, you subscribe a url once and roost posts a signed json event to it every time a matching event occurs.

---

## what webhooks are

a webhook is an http `POST` that roost sends to a url you control whenever a subscribed event fires in your site. the request body is a json envelope describing the event; the headers carry a signature you verify before trusting the payload. your endpoint returns any `2xx` status to acknowledge receipt — anything else (or a timeout) counts as a failed delivery and is retried.

the model is stripe/github shaped: one subscription per url, each scoped to a site and to an explicit list of event types. secrets are per-subscription, shown once at creation, and rotatable with a grace window.

---

## event catalog

every delivery envelope has the shape:

```json
{
  "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y0",
  "event": "manifest.published",
  "occurredAt": "2026-04-22T15:30:00Z",
  "data": { }
}
```

`id` is a ulid unique to the event (use it with `Roost-Delivery` for dedup). `event` is the stable event-type string. `occurredAt` is rfc 3339 utc. `data` is event-specific and documented below.

### roost lifecycle

- **`roost.created`** — a new roost was created via `POST /api/roosts`.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y0",
    "event": "roost.created",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "name": "lobby-touchdesigner",
      "targets": ["machine-a7f3", "machine-b2c1"]
    }
  }
  ```

- **`roost.updated`** — a roost's name or target list changed via `PATCH /api/roosts/{id}`.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y1",
    "event": "roost.updated",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "changed": ["targets"],
      "targets": ["machine-a7f3", "machine-b2c1", "machine-c3d4"]
    }
  }
  ```

- **`roost.deleted`** — a roost was soft-deleted via `DELETE /api/roosts/{id}`.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y2",
    "event": "roost.deleted",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "deletedAt": "2026-04-22T15:30:00Z",
      "purgeAt": "2026-05-22T15:30:00Z"
    }
  }
  ```

### manifests

- **`manifest.published`** — a new manifest was published via `POST /api/roosts/{id}/manifests` and the roost's current pointer moved to it.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y3",
    "event": "manifest.published",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "manifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "previousManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "totalFiles": 342,
      "totalSize": 2147483648
    }
  }
  ```

- **`manifest.rolled_back`** — a rollback flipped the roost's current manifest pointer to a prior version.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y4",
    "event": "manifest.rolled_back",
    "occurredAt": "2026-04-22T15:35:00Z",
    "data": {
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "fromManifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "toManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W3"
    }
  }
  ```

### deployments

- **`deployment.started`** — a rollout began fanning out to targets.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y5",
    "event": "deployment.started",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W2",
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "manifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "strategy": "canary-then-fleet",
      "machineCount": 2
    }
  }
  ```

- **`deployment.completed`** — every machine in the rollout reached `succeeded`.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y6",
    "event": "deployment.completed",
    "occurredAt": "2026-04-22T15:34:12Z",
    "data": {
      "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W2",
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "manifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "machineCount": 2,
      "successCount": 2,
      "failureCount": 0,
      "durationMs": 252000
    }
  }
  ```

- **`deployment.failed`** — the rollout hit a terminal failure (canary failed, or per-machine retry budget exhausted).
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y7",
    "event": "deployment.failed",
    "occurredAt": "2026-04-22T15:33:48Z",
    "data": {
      "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W2",
      "roostId": "roost_lobby_td",
      "siteId": "kiosk-fleet-01",
      "manifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "failedMachines": [
        { "machineId": "machine-b2c1", "error": "chunk_verify_failed", "digest": "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce" }
      ]
    }
  }
  ```

### machines

- **`machine.online`** — a machine resumed reporting heartbeats after being offline.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y8",
    "event": "machine.online",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "machineId": "machine-a7f3",
      "siteId": "kiosk-fleet-01",
      "name": "lobby-display-01",
      "lastHeartbeat": "2026-04-22T15:29:58Z",
      "offlineSince": "2026-04-22T14:02:12Z"
    }
  }
  ```

- **`machine.offline`** — a machine's heartbeat went stale past the threshold.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Y9",
    "event": "machine.offline",
    "occurredAt": "2026-04-22T14:02:12Z",
    "data": {
      "machineId": "machine-a7f3",
      "siteId": "kiosk-fleet-01",
      "name": "lobby-display-01",
      "lastHeartbeat": "2026-04-22T13:57:00Z"
    }
  }
  ```

### chunks

- **`chunk.garbage_collected`** — a chunk was reclaimed by the gc sweeper after losing all referrers and serving its 30-day grace period.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z0",
    "event": "chunk.garbage_collected",
    "occurredAt": "2026-04-22T03:00:00Z",
    "data": {
      "digest": "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
      "siteId": "kiosk-fleet-01",
      "sizeBytes": 4194304,
      "unreferencedSince": "2026-03-22T03:00:00Z"
    }
  }
  ```

- **`chunk.verify_failed`** — a background verify pass found bytes at rest that do not match their claimed digest.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z1",
    "event": "chunk.verify_failed",
    "occurredAt": "2026-04-22T04:15:00Z",
    "data": {
      "digest": "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
      "siteId": "kiosk-fleet-01",
      "expectedDigest": "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
      "actualDigest": "sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
      "affectedManifests": ["sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"]
    }
  }
  ```

### quota

- **`quota.warning`** — site storage usage crossed the 50% or 80% threshold. fired once per threshold per billing period.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z2",
    "event": "quota.warning",
    "occurredAt": "2026-04-22T10:00:00Z",
    "data": {
      "siteId": "kiosk-fleet-01",
      "tier": "pro",
      "threshold": 0.8,
      "usedBytes": 85899345920,
      "limitBytes": 107374182400
    }
  }
  ```

- **`quota.exceeded`** — site hit 100% of its storage or bandwidth limit; writes are rejected with `quota_exceeded` until usage drops or the period resets.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z3",
    "event": "quota.exceeded",
    "occurredAt": "2026-04-22T11:30:00Z",
    "data": {
      "siteId": "kiosk-fleet-01",
      "tier": "pro",
      "resource": "storage",
      "usedBytes": 107374182400,
      "limitBytes": 107374182400,
      "periodResetsAt": "2026-05-01T00:00:00Z"
    }
  }
  ```

### api keys

- **`api_key.used`** — an api key authenticated a request (sampled; not fired for every call — intended for first-use-from-new-ip alerting).
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z4",
    "event": "api_key.used",
    "occurredAt": "2026-04-22T15:30:00Z",
    "data": {
      "keyId": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
      "keyPrefix": "owk_live_kB8n3p",
      "ip": "203.0.113.42",
      "userAgent": "roost-cli/0.1.0",
      "firstUseFromIp": true
    }
  }
  ```

- **`api_key.expired`** — an api key's `expiresAt` has passed; subsequent requests return `401 token_expired`.
  ```json
  {
    "id": "evt_01HYCAM5T4P9R1S3U7V8W0X2Z5",
    "event": "api_key.expired",
    "occurredAt": "2026-07-21T15:30:00Z",
    "data": {
      "keyId": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
      "keyPrefix": "owk_live_kB8n3p",
      "name": "ci/cd — prod",
      "expiresAt": "2026-07-21T15:30:00Z"
    }
  }
  ```

---

## signature format

every delivery carries a `Roost-Signature` header modeled on stripe's:

```
Roost-Signature: t=1745334602,v1=5f3e8a7c2b9d1e4f6a8c0e2d4f6a8c0e2d4f6a8c0e2d4f6a8c0e2d4f6a8c0e2d
```

- **`t`** — unix timestamp (seconds) when roost generated the signature.
- **`v1`** — hex-encoded `hmac-sha256(signingSecret, "<t>.<raw_body>")` where `<raw_body>` is the exact bytes of the request body (no whitespace normalization, no re-serialization).

verification has three steps, all mandatory:

1. recompute `v1` from the signing secret, the `t` value from the header, and the raw request body. compare using **constant-time** comparison (`hmac.compare_digest` in python, `crypto.timingSafeEqual` in node).
2. reject if `|now - t| > 300` (5-minute replay tolerance). this is what stops a stolen payload from being replayed an hour later.
3. be idempotent on `Roost-Delivery` — if you've already processed that delivery id, respond `200` without reprocessing.

the `v1=` prefix leaves room for a future `v2=` algorithm. verifiers should iterate every `v*=` pair in the header and accept if any matches, ignoring unknown schemes.

---

## signature verification

all three examples below implement the same three-step protocol: split the header, check the timestamp against a 5-minute window, and constant-time-compare the hmac. prefer the sdk helpers over hand-rolled code — they ship with the replay check wired in and use timing-safe comparison by default.

### node

```ts
// npm install @owlette/roost express
import express from 'express';
import { verifySignature } from '@owlette/roost';

const app = express();
const SECRET = process.env.ROOST_WEBHOOK_SECRET!;

// webhooks need the raw body bytes — register the raw parser BEFORE
// json-parser on this route.
app.post(
  '/webhooks/roost',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const verdict = verifySignature(
      req.headers['roost-signature'] as string | undefined,
      req.body as Buffer,               // raw bytes, NOT the parsed json
      SECRET,
      // { toleranceSeconds: 300 } — default; override only if you must.
    );
    if (!verdict.ok) {
      // possible reasons: missing_header | malformed | outside_tolerance | bad_signature
      return res.status(401).json({ error: verdict.reason });
    }

    const event = JSON.parse(req.body.toString('utf-8'));

    // dedup on Roost-Delivery — a retry of the same attempt keeps the id.
    const deliveryId = String(req.headers['roost-delivery']);
    if (await isAlreadyProcessed(deliveryId)) return res.status(200).end();

    await handle(event);
    res.status(200).end();
  },
);

app.listen(8080);
```

### python

```python
# pip install owlette-roost fastapi uvicorn
import os
from fastapi import FastAPI, Request, HTTPException
from roost import verify_signature

app = FastAPI()
SECRET = os.environ["ROOST_WEBHOOK_SECRET"]

@app.post("/webhooks/roost")
async def webhook(request: Request):
    raw = await request.body()            # raw bytes — never use request.json()
    sig = request.headers.get("roost-signature")
    verdict = verify_signature(sig, raw, secret=SECRET)
    if not verdict.ok:
        # reason: "missing_header" | "malformed" | "outside_tolerance" | "bad_signature"
        raise HTTPException(status_code=401, detail=verdict.reason or "bad_signature")

    delivery_id = request.headers.get("roost-delivery", "")
    if await is_already_processed(delivery_id):
        return {"ok": True, "deduped": True}

    import json
    event = json.loads(raw)
    await handle(event)
    return {"ok": True}
```

### bash

no sdk — pure `openssl` + `jq`. useful when your receiver is a shell pipeline or a cloud function where adding a sdk is overkill. run this as a cgi script or behind a tiny http wrapper.

```bash
#!/usr/bin/env bash
# verify-roost-webhook.sh — stdin is the raw request body; headers are in env vars
#                          HTTP_ROOST_SIGNATURE + HTTP_ROOST_DELIVERY (cgi style).

set -euo pipefail

: "${ROOST_WEBHOOK_SECRET:?set to the signing secret returned by POST /api/webhooks}"
TOLERANCE_SECONDS="${TOLERANCE_SECONDS:-300}"

body="$(cat)"                                         # raw bytes from stdin
sig_header="${HTTP_ROOST_SIGNATURE:-}"
[[ -n "$sig_header" ]] || { echo "missing Roost-Signature" >&2; exit 1; }

# parse "t=<unix>,v1=<hex>" — tolerate other v*= schemes following it
t=""; v1=""
while IFS= read -r part; do
  case "$part" in
    t=*)  t="${part#t=}" ;;
    v1=*) v1="${part#v1=}" ;;
  esac
done < <(tr ',' '\n' <<<"$sig_header")
[[ -n "$t" && -n "$v1" ]] || { echo "malformed signature header" >&2; exit 1; }

# replay window
now="$(date -u +%s)"
delta=$(( now > t ? now - t : t - now ))
(( delta <= TOLERANCE_SECONDS )) || { echo "outside_tolerance ($delta s)" >&2; exit 1; }

# recompute v1 = hmac_sha256(secret, "<t>.<body>")
expected="$(printf '%s.%s' "$t" "$body" \
  | openssl dgst -sha256 -hmac "$ROOST_WEBHOOK_SECRET" -hex \
  | awk '{print $NF}')"

# constant-time compare: use openssl's equal-length buffer diff via `cmp`
[[ "${#expected}" -eq "${#v1}" ]] || { echo "bad_signature" >&2; exit 1; }
if ! cmp --silent <(printf '%s' "$expected") <(printf '%s' "$v1"); then
  echo "bad_signature" >&2; exit 1
fi

echo "ok  delivery=${HTTP_ROOST_DELIVERY:-<none>}  event=$(jq -r '.event // empty' <<<"$body")"
```

> **note on bash timing safety** — `cmp --silent` is the closest posix has to a constant-time hex compare. the hash values are non-secret on one side (the computed `$expected`) and the attacker-controlled `$v1` has fixed length, so timing leaks here are not exploitable in practice. if you need strict constant-time comparison, run the python or node examples instead.

---

## delivery headers

every webhook `POST` includes:

- **`Content-Type: application/json`** — body is always a json envelope.
- **`Roost-Event: <event.name>`** — redundant with the body's `event` field; useful for routing without parsing the body.
- **`Roost-Delivery: <uuid>`** — unique per delivery attempt (manual retries get a new id; automatic retries of the same attempt do not). use this as your idempotency key on the receiver.
- **`Roost-Signature: t=<unix>,v1=<hex>`** — see signature format above.
- **`User-Agent: Owlette-Webhooks/1.0`** — stable user agent for allowlisting.

---

## delivery guarantees

- **at-least-once.** a delivery may arrive more than once if your receiver times out after processing but before returning `2xx`. dedup on `Roost-Delivery`.
- **retries.** any non-2xx response (or transport error) triggers exponential backoff: 10s, 30s, 2m, 10m, 1h, 6h, 24h. each attempt gets a fresh `Roost-Signature` timestamp but the same `Roost-Delivery` id.
- **dead letter.** after 10 failed attempts over ~24h the delivery is marked `failed`, the subscription records the failure in its delivery history, and the next fresh event still attempts delivery. 5 consecutive terminal failures pauses the subscription until a manual `PATCH /api/webhooks/{id}` sets `paused: false`.
- **retention.** delivery history (request + response transcript) is retained for 30 days and is available via `GET /api/webhooks/{id}/deliveries`.
- **ordering.** deliveries are not globally ordered. if you need to reason about order, use `occurredAt` in the payload; do not rely on the order deliveries arrive.

---

## subscription management

every operation on a webhook subscription — create, list, detail, update, delete, rotate-secret, delivery history, manual retry, and url probe — is a public api endpoint. see the corresponding sections in [`api-surface.md` §10](../../dev/active/roost-public-api/reference/api-surface.md#10-webhooks) for full request/response shapes:

- `POST /api/webhooks` — create a subscription (returns `signingSecret` once).
- `GET /api/webhooks` / `GET /api/webhooks/{id}` — list / detail.
- `PATCH /api/webhooks/{id}` — update url, events, description, or paused state.
- `DELETE /api/webhooks/{id}` — permanently delete.
- `POST /api/webhooks/{id}/rotate-secret` — mint a new signing secret with a 24h grace window.
- `GET /api/webhooks/{id}/deliveries` / `GET /api/webhooks/{id}/deliveries/{deliveryId}` — delivery history + single delivery detail.
- `POST /api/webhooks/{id}/deliveries/{deliveryId}/retry` — manually redeliver a past event.
- `POST /api/webhooks/probe` — fire a synthetic event at a url without creating a subscription (smoke-test signature verification).

scopes: every webhook endpoint requires `site:<siteId>:admin`. keys with narrower scopes cannot manage subscriptions.

---

## local development

the `roost` cli ships an event-tunnel so you can receive live webhooks on your laptop without opening a port to the public internet. it connects to the server-sent-events stream at `GET /api/events/stream`, re-signs each event with a **local** test secret, and POSTs to your local receiver. the production subscription (with its real secret) is never touched — this is a dev-side mirror, not a real delivery.

```bash
# 1. log in once per machine (stores an api token in ~/.config/roost/config.toml)
roost auth login

# 2. start your receiver on :8080, using a throwaway test secret
export ROOST_WEBHOOK_SECRET=whsec_local_dev_0000000000000000000000000000000000
node my-receiver.js &

# 3. tunnel prod events into it
roost listen \
  --site kiosk-fleet-01 \
  --forward-to http://localhost:8080/webhooks/roost \
  --signing-secret "$ROOST_WEBHOOK_SECRET" \
  --events manifest.published,deployment.failed

# → every matching event is re-signed with your local secret and POSTed
#   to localhost. Ctrl-C to stop. the tunnel leaves no trace on the server.
```

a matching event looks like:

```
event manifest.published → http://localhost:8080/webhooks/roost  200 OK  (34 ms)
event deployment.failed  → http://localhost:8080/webhooks/roost  200 OK  (28 ms)
```

common local-dev patterns:

- **verifying a new integration without touching prod.** `roost trigger manifest.published --to http://localhost:8080/webhooks/roost --signing-secret "$ROOST_WEBHOOK_SECRET"` fires a single canned event locally. no tunnel, no subscription, no network.
- **smoke-testing a public receiver before subscribing.** `POST /api/webhooks/probe` (or `roost trigger <event> --site <id>`) fires a one-shot signed payload at any https url + returns the request body + signature so you can confirm your receiver accepts the signature before you create a real subscription.
- **debugging a stuck delivery.** `GET /api/webhooks/{id}/deliveries` lists the last 30 days of attempts with full request/response transcripts; `POST /api/webhooks/{id}/deliveries/{deliveryId}/retry` queues the same payload for redelivery with a fresh `Roost-Signature` timestamp so it slides back inside the 5-minute tolerance window.
