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

`TODO: wave 6` — runnable code examples for node, python, and bash will be filled in alongside the webhook endpoint implementation. until then, follow the three-step rule above and any off-the-shelf stripe-signature verifier will work with a one-line header-name change.

### node

`TODO: wave 6`

### python

`TODO: wave 6`

### bash

`TODO: wave 6`

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

`TODO: wave 6` — the `roost listen --forward-to` walkthrough will cover: starting an ephemeral subscription scoped to the current key, forwarding production events to `http://localhost:<port>/...`, re-signing with a local test secret, and cleaning up the subscription on `ctrl-c`. until the cli ships, use `POST /api/webhooks/probe` against a public tunnel (e.g. cloudflared) to smoke-test your receiver.
