# authentication

**Last updated**: 2026-04-22

the roost public api authenticates every request with a scoped bearer token. this doc covers the full lifecycle: creating a key, using it, scoping it, rotating it, revoking it, and surviving the legacy-key deprecation window.

---

## tl;dr

```http
GET /api/roosts?siteId=kiosk-fleet-01 HTTP/1.1
Host: owlette.app
Authorization: Bearer owk_live_kB8n3pQrT5wXvZ2yA9cF1dG4hJ6mN8oL0sU
Roost-Version: 2026-04-22
```

- tokens look like `owk_live_<24 chars>` (production) or `owk_test_<24 chars>` (sandbox).
- every key carries a scope list — no full-access keys.
- every key has an expiration (default 90 days, max 365).
- the raw key is shown **once** at creation. store it in a secrets manager immediately.

---

## creating an api key

### via the dashboard

1. sign in to [owlette.app](https://owlette.app) (or `dev.owlette.app`).
2. open **settings → api keys**.
3. click **new key**.
4. fill in:
   - **name** — human label (e.g. `ci/cd — prod`).
   - **environment** — `live` or `test`.
   - **scopes** — pick resources + permissions, or apply a preset (see [scope presets](#scope-presets)).
   - **expiration** — default 90 days, max 365.
5. hit **create**. the raw key is shown **once** — copy it to your secrets manager immediately; you cannot retrieve it again.

### via the api

`POST /api/keys` requires a signed-in **user session**, not an api key (you cannot bootstrap a key with another key). use this flow when provisioning keys from infrastructure-as-code against a service account.

```bash
curl -X POST "https://owlette.app/api/keys" \
  -H "Authorization: Bearer $OWLETTE_USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "name": "ci/cd — prod",
    "environment": "live",
    "scopes": [
      { "resource": "roost", "id": "*", "permissions": ["read", "write", "deploy"] },
      { "resource": "site", "id": "kiosk-fleet-01", "permissions": ["read"] }
    ],
    "ttlDays": 90
  }'
```

response (`201 Created`):

```json
{
  "id": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
  "key": "owk_live_kB8n3pQrT5wXvZ2yA9cF1dG4hJ6mN8oL0sU",
  "name": "ci/cd — prod",
  "environment": "live",
  "scopes": [
    { "resource": "roost", "id": "*", "permissions": ["read", "write", "deploy"] },
    { "resource": "site", "id": "kiosk-fleet-01", "permissions": ["read"] }
  ],
  "keyPrefix": "owk_live_kB8n3p",
  "expiresAt": "2026-07-21T15:30:00Z",
  "createdAt": "2026-04-22T15:30:00Z"
}
```

the `key` field appears in this response and nowhere else. subsequent `GET /api/keys/{id}` calls return `keyPrefix` only.

---

## using an api key

every authenticated request sends the raw key as an `Authorization: Bearer` header:

```http
Authorization: Bearer owk_live_kB8n3pQrT5wXvZ2yA9cF1dG4hJ6mN8oL0sU
```

### live vs test environments

| prefix | environment | traffic | r2 bucket | audit log | rate limits |
|---|---|---|---|---|---|
| `owk_live_*` | production | real fleets, billable storage + bandwidth | `owlette-prod` | writes production audit records | production tier |
| `owk_test_*` | sandbox | synthetic / dev machines, non-billable | `owlette-test` | writes test audit records (separate chain) | higher burst, lower sustained |

the two environments are strictly isolated: a test key cannot read, write, or deploy against a live resource, and vice versa. requests that cross the boundary return `403 scope_insufficient`. keep ci/cd and production integrations on `live`; keep local dev, integration tests, and sdk examples on `test`.

### verifying the current identity

`GET /api/whoami` echoes back the resolved identity, scopes, rate-limit snapshot, and quota. useful for sanity checks in sdks and cli tools.

```bash
curl "https://owlette.app/api/whoami" \
  -H "Authorization: Bearer $OWK_LIVE"
```

```json
{
  "userId": "user_01HWABCD1234EFGH5678IJKL90",
  "keyId": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
  "keyPrefix": "owk_live_kB8n3p",
  "environment": "live",
  "scopes": [
    { "resource": "roost", "id": "*", "permissions": ["read", "write", "deploy"] }
  ],
  "rateLimit": { "limit": 1000, "remaining": 987, "resetAt": "2026-04-22T15:31:00Z" },
  "quota": { "tier": "pro", "usedBytes": 23456789012, "limitBytes": 107374182400 }
}
```

### auth error codes

| status | code | meaning |
|---|---|---|
| 401 | `auth_required` | no `Authorization` header, or malformed token |
| 401 | `token_expired` | key passed its `expiresAt`; see [rotation](#rotating-a-key) |
| 401 | `token_revoked` | key was explicitly revoked (see [revocation](#revoking-a-key)) |
| 403 | `scope_insufficient` | key is valid but lacks permission for this resource/action |
| 403 | `environment_mismatch` | `owk_test_*` key used against live resource (or vice versa) |

all errors follow the `application/problem+json` envelope documented in `docs/api/errors.md`.

---

## scopes

every key carries a `scopes[]` array. a key without at least one scope cannot be created — there is no "full-access" key in the public api.

### scope syntax

```json
[
  { "resource": "roost",   "id": "roost_lobby_td",  "permissions": ["read", "write"] },
  { "resource": "site",    "id": "kiosk-fleet-01",  "permissions": ["read"] },
  { "resource": "machine", "id": "*",               "permissions": ["read"] }
]
```

each scope object has three fields:

- **`resource`** — one of `roost`, `site`, `machine`.
- **`id`** — a specific resource id, or `*` to grant the scope across every resource of that type the user owns.
- **`permissions`** — a non-empty subset of `read`, `write`, `deploy`, `rollback`, `admin`.

a request passes authorization iff there is at least one scope entry whose resource matches, whose id matches (exact or `*`), and whose permissions include the one required by the endpoint.

### resource types

| resource | what it covers | notes |
|---|---|---|
| `roost` | a named versioned bundle (versions, chunks referenced by those versions, deploys/rollbacks targeting it) | scopes with `resource: "roost", id: "*"` grant access to every roost across every site the user owns. |
| `site` | a tenant boundary (machines, quotas, audit log, webhooks, sites list entry) | scopes at the site level do **not** implicitly grant access to roosts inside that site — add an explicit `roost` scope if needed. |
| `machine` | machine detail + deployment history for a single agent | used for read-only observability keys (e.g. a monitoring sidecar). |

### permissions

| permission | grants |
|---|---|
| `read` | list + detail `GET`s on the resource, version download urls, deployment history |
| `write` | create/rename/delete roosts, publish versions, upload chunks |
| `deploy` | trigger `POST /api/roosts/{id}/deploy` (targeted fan-out, canary, scheduled rollout) |
| `rollback` | trigger `POST /api/roosts/{id}/rollback` (pointer flip) |
| `admin` | webhook management, operational log clearing, key-level settings on the resource |

permissions are additive and do not imply one another. `deploy` does not imply `write`; `write` does not imply `deploy`. a publisher key that also needs to roll back must list both `deploy` and `rollback` explicitly.

the exact scope each endpoint requires is listed in the endpoint's reference page and in `web/openapi.yaml` under `security`.

### scope presets

the dashboard offers four presets to cover the common cases. each expands to a canonical `scopes[]` the api accepts verbatim.

| preset | scopes | use case |
|---|---|---|
| **`readonly`** | `[{ resource: "site", id: "<siteId>", permissions: ["read"] }, { resource: "roost", id: "*", permissions: ["read"] }]` | dashboards, observability, read-only monitoring; cannot publish, deploy, or rollback. |
| **`publisher`** | `[{ resource: "roost", id: "*", permissions: ["read", "write"] }]` | ci/cd that builds + uploads versions but does not trigger rollout (paired with a human-approved `operator` key for the deploy step). |
| **`operator`** | `[{ resource: "roost", id: "*", permissions: ["read", "deploy", "rollback"] }]` | on-call rollout + rollback tooling; cannot modify roost contents. |
| **`admin`** | `[{ resource: "site", id: "<siteId>", permissions: ["read", "admin"] }, { resource: "roost", id: "*", permissions: ["read", "write", "deploy", "rollback", "admin"] }]` | site-wide automation: webhook management, audit log access, full lifecycle. treat as root-equivalent. |

presets are a starting point — you can always narrow them further (remove an id wildcard, drop a permission). you cannot broaden a preset by editing the scopes after creation (see [narrowing scopes](#narrowing-scopes)).

---

## expiration

every key expires. this is not optional.

- **default ttl**: 90 days from creation.
- **maximum ttl**: 365 days. requests with `ttlDays > 365` return `400 validation_failed`.
- **minimum ttl**: 1 day.
- **past `expiresAt`**: the api returns `401 token_expired`. the key is not auto-renewed — rotate it before it expires (see [rotation](#rotating-a-key)).
- **warnings**: responses within 14 days of `expiresAt` include an `X-Roost-Key-Expiring: <iso8601>` header so cli and sdks can surface a warning.

expiration closes the leak path of "a key a former contractor pushed to github five years ago, still valid today." plan rotations on a calendar (quarterly for 90-day keys) rather than reactively.

---

## rotating a key

rotation mints a **new raw key value** for the same key id. the old value keeps working for a 24-hour grace window so you can deploy the new secret without downtime.

```bash
curl -X POST "https://owlette.app/api/keys/key_01HXYZA7F3B2C1D0E9F8G7H6J5/rotate" \
  -H "Authorization: Bearer $OWLETTE_USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "graceHours": 24 }'
```

response (`200 OK`):

```json
{
  "id": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
  "key": "owk_live_nR9mT2qS4wVxYz1bB8cE0dF3gH5iJ7kL9mO",
  "keyPrefix": "owk_live_nR9mT2",
  "previousKeyExpiresAt": "2026-04-23T15:30:00Z",
  "rotatedAt": "2026-04-22T15:30:00Z"
}
```

### rotation flow

1. call `POST /api/keys/{id}/rotate` and capture the new raw `key`.
2. deploy the new value to every caller (secrets manager, ci/cd, sdks).
3. verify traffic is flowing on the new key (`GET /api/whoami` → `keyPrefix` matches the new prefix; dashboard **last used** timestamp updates).
4. wait for `previousKeyExpiresAt`. the old value stops working at that moment.

rotate aggressively on any suspected leak. rotation is free, idempotent via `Idempotency-Key`, and does not change the key's `id`, `scopes`, or `expiresAt`.

- **`graceHours` bounds**: `0` (immediate cutover, no overlap) to `72` (max 3 days). values outside this range return `400 validation_failed`.
- **revoked keys**: rotating a revoked key returns `412 precondition_failed`. create a new key instead.
- **scope is unchanged**: rotation does not re-prompt for scopes — it replaces the secret only.

### narrowing scopes

`PATCH /api/keys/{id}` lets you rename a key or **narrow** its scopes. scopes can only be made more restrictive (remove a permission, replace `*` with a specific id, drop a scope entry entirely). any attempt to broaden returns `400 validation_failed`.

```bash
curl -X PATCH "https://owlette.app/api/keys/key_01HXYZA7F3B2C1D0E9F8G7H6J5" \
  -H "Authorization: Bearer $OWLETTE_USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ci/cd — prod (publish-only)",
    "scopes": [
      { "resource": "roost", "id": "roost_lobby_td", "permissions": ["read", "write"] }
    ]
  }'
```

to **broaden** scopes, create a new key. this is deliberate — it forces a fresh audit-log entry for the scope change.

---

## revoking a key

revocation is permanent. the key is unusable within 60 seconds across every edge cache (most requests fail immediately).

```bash
curl -X DELETE "https://owlette.app/api/keys/key_01HXYZA7F3B2C1D0E9F8G7H6J5" \
  -H "Authorization: Bearer $OWLETTE_USER_SESSION_TOKEN"
```

response: `204 No Content`.

revoke a key when:

- you suspect it has leaked (and rotation isn't enough — rotation keeps the same key id; revocation burns it).
- a contractor or service that held it is decommissioned.
- it was created by mistake or with overly broad scopes (revoke + create new, narrower key).

revoked keys remain in `GET /api/keys` with `revokedAt` set for audit purposes. there is no un-revoke — mint a new key instead.

---

## security best practices

- **never commit a key to git.** use environment variables or a secrets manager (github actions secrets, aws secrets manager, doppler, 1password cli). gitguardian, trufflehog, and github secret scanning recognise the `owk_live_` / `owk_test_` prefix and will alert on accidental commits — but do not rely on scanners as your primary line of defence.
- **rotate immediately on any suspected leak.** the 24-hour grace window exists so you can rotate without downtime; use it. if the key might already be in use by an attacker, set `graceHours: 0` and cut over instantly, then revoke.
- **least-privilege scopes.** do not grant `admin` to a ci/cd key that only needs to publish. start from the narrowest preset (`readonly`, `publisher`, `operator`) and add permissions only when an endpoint returns `403 scope_insufficient`.
- **separate keys per use case.** one key per integration point (ci/cd, monitoring, the slack bot, each developer's laptop). this way you can revoke one without taking down the others, and the audit log's `actor.id` tells you exactly which integration did what.
- **separate keys per environment.** never reuse a key across live and test — the prefix already enforces this at the api, but the same applies to staging vs production pipelines.
- **prefer short ttls.** 30-day keys for ci/cd, 7-day keys for incident-response break-glass scenarios, 90-day default only when rotation tooling exists. the harder it is to rotate, the shorter the ttl should be — this forces you to build the rotation tooling.
- **monitor `api_key.used` webhooks.** subscribe to the `api_key.used` event to detect unexpected callers (new ip ranges, new user agents, off-hours activity).
- **rely on the audit log.** every call made with a key appears in the site audit log with the key's `id` and a `scopeFingerprint` — use `GET /api/sites/{siteId}/audit-log?actor=apiKey:<keyId>` after any suspected incident.

---

## legacy key deprecation (90-day grace)

v1 of the api issued unscoped, non-expiring keys with the plain `owk_` prefix. those keys continue to work for **90 days** after the public api launch, then stop.

### during the grace window

- legacy keys are treated as **full-access** (every permission on every resource the user owns).
- every response to a request authenticated by a legacy key includes a deprecation header:
  ```http
  X-Roost-Deprecation: legacy-key; rotate before 2026-07-21T00:00:00Z; see https://docs.owlette.app/api/authentication#legacy-key-deprecation
  ```
- the dashboard **settings → api keys** page highlights every legacy key with a red badge and a one-click "rotate into scoped key" action.
- the `X-Roost-Deprecation` header also appears on **successful** responses, not just errors — this is intentional, so it reaches callers that are silently working.

### after the grace window

- legacy keys return `401 token_expired` with a `detail` pointing at this page.
- there is no extension. rotating early is free; rotating late requires a user session.

### migrating a legacy key to a scoped key

1. in the dashboard, note every integration that currently uses the legacy key (check the audit log for the key's `actor.id` to find unique user agents / ip ranges).
2. for each integration, decide the **minimum** scope it needs:
   - ci/cd that pushes to one roost? → `publisher` preset narrowed to that one roost id.
   - monitoring dashboard? → `readonly` preset.
   - on-call rollback tooling? → `operator` preset.
3. create a new scoped key per integration (`POST /api/keys`).
4. deploy the new key alongside the legacy key. verify the new key works via `GET /api/whoami` + a real request.
5. switch each integration to the new key. watch for `403 scope_insufficient` — if anything breaks, narrow too tight; add the missing permission and redeploy.
6. once every integration is switched, revoke the legacy key (`DELETE /api/keys/<legacyId>`). do not wait for the grace window to expire.

creating many new keys in one migration burst is fine — the per-user active-key quota is 50.

---

## related reading

- `docs/api/overview.md` — base urls, conventions, common headers.
- `docs/api/errors.md` — full error envelope + code reference.
- `docs/api/rate-limits.md` — `RateLimit-*` headers + per-tier limits.
- `docs/api/webhooks.md` — `Roost-Signature` verification for webhook receivers.
- `dev/active/roost-public-api/reference/design-principles.md` — principle 7 (scoped prefixed tokens) and the full principle catalog.
