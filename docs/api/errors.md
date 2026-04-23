# roost api — errors

every non-2xx response from the roost api is a structured problem document — never a plain-text string, never a bespoke `{error: "..."}` envelope, never html. clients switch on the stable `code` field; humans follow the `doc_url` back here for remediation; support engineers trace issues by `requestId`.

this page is the authoritative catalog. every error code the api emits is listed with its http status, what triggers it, and how to remediate.

---

## error envelope

every non-2xx response has `Content-Type: application/problem+json` and follows [rfc 7807](https://datatracker.ietf.org/doc/html/rfc7807) extended with stripe-inspired fields.

```json
{
  "type": "https://roost.dev/errors/quota-exceeded",
  "title": "Quota exceeded",
  "status": 402,
  "detail": "site kiosk-fleet-01 has used 5.2 gb of its 5 gb plan",
  "code": "quota_exceeded",
  "param": "siteId",
  "doc_url": "https://owlette.app/docs/api/errors#quota_exceeded",
  "request_log_url": "https://owlette.app/admin/requests/req_01HY…",
  "requestId": "req_01HY…"
}
```

| field | purpose |
|---|---|
| `type` | permanent url identifying the problem class. dereference for docs. |
| `title` | short human-readable summary. does not change between occurrences. |
| `status` | http status code, mirrored in the response status line. |
| `detail` | human-readable explanation for this specific occurrence. wording may change between versions — do not regex-match it. |
| `code` | stable machine-readable identifier. **this is the contract.** switch on this in client code. |
| `param` | dotted json path to the offending field (validation + precondition errors only). |
| `doc_url` | deep link to the `#<code>` anchor on this page. safe to surface in client ui. |
| `request_log_url` | dashboard link to the full request/response transcript for this call. only populated for authenticated requests. |
| `requestId` | correlation id. mirrored in the `X-Request-Id` response header. include it in any support ticket. |

additional implementation-specific fields may appear alongside the above for specific error classes (e.g. `retryAfter`, `expected`, `actual`, `errors{}`). treat unknown fields as forward-compatible extensions and ignore them if you do not recognise them.

---

## stable type urls

every `type` field is a permanent url at `https://roost.dev/errors/{code}`. visiting one redirects to the `#<code>` anchor on this page. the redirect is guaranteed stable across api versions — urls already emitted in logs, support tickets, and error reports will keep resolving after future releases.

- `https://roost.dev/errors/quota-exceeded` → [#quota_exceeded](#quota_exceeded)
- `https://roost.dev/errors/validation-failed` → [#validation_failed](#validation_failed)
- (one url per code below)

the convention: the url path is the `code` with underscores rewritten as hyphens (`quota_exceeded` → `quota-exceeded`). code switches should match on the `code` field, not the `type` url — but the url is what you click or paste into a chat window.

---

## error code catalog

one subsection per code, alphabetical. every code emitted by the api is listed here.

### `auth_required`

- **http status**: 401 Unauthorized
- **meaning**: the request did not carry a usable credential.
- **triggers**: `Authorization` header missing, malformed, not `Bearer`, or referring to an unknown key id.
- **remediate**: send `Authorization: Bearer owk_live_...` (or `owk_test_...` in test mode). if you thought you were authenticated, check the header actually made it through your proxy/sdk. keys are managed at `POST /api/keys`.

```json
{
  "type": "https://roost.dev/errors/auth-required",
  "title": "Authentication required",
  "status": 401,
  "detail": "missing or malformed Authorization header",
  "code": "auth_required",
  "doc_url": "https://owlette.app/docs/api/errors#auth_required",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `chunk_not_found`

- **http status**: 400 Bad Request
- **meaning**: a manifest publish or mount referenced a chunk digest that is not present in the site's content-addressed store.
- **triggers**: calling `POST /api/roosts/{roostId}/manifests` or `POST /api/chunks/{digest}/mount` with a digest the server has never seen (or has garbage-collected).
- **remediate**: re-run `POST /api/chunks/check` to identify the missing digests, upload them via `POST /api/chunks/upload-urls`, then retry the publish. this is almost always a client bug where `/check` was skipped or its result was ignored.

```json
{
  "type": "https://roost.dev/errors/chunk-not-found",
  "title": "Chunk not found",
  "status": 400,
  "detail": "manifest references chunk sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce which is not in storage for site kiosk-fleet-01",
  "code": "chunk_not_found",
  "param": "manifest.layers[2].digest",
  "doc_url": "https://owlette.app/docs/api/errors#chunk_not_found",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `conflict`

- **http status**: 409 Conflict
- **meaning**: the request is logically inconsistent with the current state of the resource in a way that no retry can fix without changing the payload.
- **triggers**: calling `POST /api/roosts/{roostId}/rollback` with no `targetManifestId` when the roost has no `previousManifestId`; creating a resource whose unique constraints collide with an existing one (distinct from `idempotency_key_mismatch`).
- **remediate**: fetch the current state (`GET /api/roosts/{roostId}`) and adjust the request. do not blind-retry — conflicts are not transient.

```json
{
  "type": "https://roost.dev/errors/conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "roost roost_lobby_td has no previous manifest to roll back to; specify targetManifestId explicitly",
  "code": "conflict",
  "doc_url": "https://owlette.app/docs/api/errors#conflict",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `idempotency_key_mismatch`

- **http status**: 409 Conflict
- **meaning**: the same `Idempotency-Key` was presented with a request body whose hash differs from the original.
- **triggers**: reusing an `Idempotency-Key` value within the 24h cache window with a different payload. per-tenant cache is keyed on `{userId, environment, idempotencyKey, sha256(requestBody)}`.
- **remediate**: generate a fresh uuid for the retry if the payload has genuinely changed. if the payload is supposed to be identical, diff the two bodies — usually it's a dynamic field (timestamp, nonce) a client inadvertently regenerated on retry.

```json
{
  "type": "https://roost.dev/errors/idempotency-key-mismatch",
  "title": "Idempotency key reused with different body",
  "status": 409,
  "detail": "Idempotency-Key 3f7b9c2a-8e14-4f1c-9d6e-2c8a5b0e9f4d was previously used with a different request body hash",
  "code": "idempotency_key_mismatch",
  "param": "Idempotency-Key",
  "doc_url": "https://owlette.app/docs/api/errors#idempotency_key_mismatch",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `internal_error`

- **http status**: 500 Internal Server Error
- **meaning**: an unhandled error occurred inside the api. the root cause is captured server-side; the response never leaks implementation detail.
- **triggers**: any uncaught exception, dependency outage, or bug. sentry alerts fire on every occurrence.
- **remediate**: retry with backoff — some 500s are transient. if it persists, open a support ticket and quote the `requestId`. that id lets support pull the full transcript and stack trace.

```json
{
  "type": "https://roost.dev/errors/internal-error",
  "title": "Internal error",
  "status": 500,
  "detail": "an internal error occurred. quote the requestId when contacting support.",
  "code": "internal_error",
  "doc_url": "https://owlette.app/docs/api/errors#internal_error",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `not_found`

- **http status**: 404 Not Found
- **meaning**: the resource does not exist, or the caller has no scope that grants it visibility. the two cases are deliberately indistinguishable — we do not confirm existence to an unauthorized caller.
- **triggers**: unknown `siteId`, `roostId`, `manifestId`, `machineId`, `keyId`, `webhookId`, `deliveryId`, chunk digest, or audit record hash.
- **remediate**: double-check the id. if the id is correct, verify the key's scope includes read on the resource (`GET /api/whoami`). if both look right, the resource may have been deleted — check the audit log or the dashboard.

```json
{
  "type": "https://roost.dev/errors/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "roost roost_lobby_td not found",
  "code": "not_found",
  "param": "roostId",
  "doc_url": "https://owlette.app/docs/api/errors#not_found",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `not_implemented`

- **http status**: 501 Not Implemented
- **meaning**: the endpoint exists in the public api surface document but the current release does not implement it yet. used for scaffolded routes during rollout waves.
- **triggers**: calling a `proposed` endpoint before its implementation wave has shipped.
- **remediate**: consult [api-surface.md](../../dev/active/roost-public-api/reference/api-surface.md) for the `status` column — `live` endpoints are safe to use, `proposed` ones return 501 until implemented. track the rollout schedule in the changelog.

```json
{
  "type": "https://roost.dev/errors/not-implemented",
  "title": "Not implemented",
  "status": 501,
  "detail": "POST /api/roosts/{roostId}/deploy is scheduled but not yet implemented in the current release",
  "code": "not_implemented",
  "doc_url": "https://owlette.app/docs/api/errors#not_implemented",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `payload_too_large`

- **http status**: 413 Payload Too Large
- **meaning**: the request body exceeded an endpoint-specific size cap.
- **triggers**: submitting a manifest document larger than 8 mib; sending more than 1000 hashes in a single `POST /api/chunks/check` or `POST /api/chunks/upload-urls` batch (those cases also surface as `validation_failed`); audit log queries with unreasonably wide filters.
- **remediate**: split the work. for manifests: reduce layer count or contact support about enterprise limits. for chunk batches: page through in batches of ≤ 1000.

```json
{
  "type": "https://roost.dev/errors/payload-too-large",
  "title": "Payload too large",
  "status": 413,
  "detail": "manifest body of 12.4 mib exceeds the 8 mib cap",
  "code": "payload_too_large",
  "doc_url": "https://owlette.app/docs/api/errors#payload_too_large",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `precondition_failed`

- **http status**: 412 Precondition Failed
- **meaning**: a conditional header (`If-Match`) or body field (`expectedCurrentManifestId`) disagreed with the current server state. classic compare-and-swap miss.
- **triggers**: racing two operators against the same roost (rollback + deploy); patching/rotating a key that is already revoked; retrying a webhook delivery on a paused or deleted subscription; audit chain verification failure; sse token already consumed.
- **remediate**: fetch the latest state (`GET /api/roosts/{roostId}`, etc.), refresh your `If-Match` value to the current digest, and retry. the response body includes `expected` and `actual` digests where applicable.

```json
{
  "type": "https://roost.dev/errors/precondition-failed",
  "title": "Precondition failed",
  "status": 412,
  "detail": "current manifest digest is sha256:cc33...dd44, not sha256:aa11...bb22",
  "code": "precondition_failed",
  "param": "If-Match",
  "expected": "sha256:aa11...bb22",
  "actual": "sha256:cc33...dd44",
  "doc_url": "https://owlette.app/docs/api/errors#precondition_failed",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `quota_exceeded`

- **http status**: 402 Payment Required
- **meaning**: a plan limit was hit. the request was refused and no state changed.
- **triggers**: site storage exceeds tier cap on chunk upload or manifest publish; exceeded max roosts per site; exceeded max 50 active api keys per user; exceeded max 25 webhooks per site; exceeded concurrent-rollouts cap.
- **remediate**: free space (delete unused roosts, wait for gc), upgrade the plan at `owlette.app/billing`, or narrow the request. `GET /api/sites/{siteId}/quota` shows current usage vs limits.

```json
{
  "type": "https://roost.dev/errors/quota-exceeded",
  "title": "Quota exceeded",
  "status": 402,
  "detail": "site kiosk-fleet-01 has used 5.2 gb of its 5 gb plan",
  "code": "quota_exceeded",
  "param": "siteId",
  "upgradeUrl": "https://owlette.app/billing?site=kiosk-fleet-01",
  "doc_url": "https://owlette.app/docs/api/errors#quota_exceeded",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `rate_limited`

- **http status**: 429 Too Many Requests
- **meaning**: the caller exceeded a rate-limit bucket. the response includes `Retry-After` (seconds) and `Roost-Rate-Limited-Reason` identifying the bucket.
- **triggers**: per-key, per-tenant-write, per-tenant-read, or global-burst bucket exhausted. buckets reset on fixed windows exposed via the `RateLimit-Reset` header.
- **remediate**: wait the `Retry-After` duration before retrying. prefer retry libraries that read the ietf `RateLimit-*` headers natively (axios-retry, urllib3 `Retry`, go rehttp). if you trip `per_key` repeatedly, consider sharding traffic across multiple keys or upgrading the plan.

```json
{
  "type": "https://roost.dev/errors/rate-limited",
  "title": "Rate limited",
  "status": 429,
  "detail": "per-key quota of 100 requests/minute exhausted; retry in 47s",
  "code": "rate_limited",
  "retryAfter": 47,
  "doc_url": "https://owlette.app/docs/api/errors#rate_limited",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

response headers:
```http
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 47
Retry-After: 47
Roost-Rate-Limited-Reason: per_key
```

---

### `scope_insufficient`

- **http status**: 403 Forbidden
- **meaning**: the credential is valid but does not carry a scope granting the requested action on the requested resource.
- **triggers**: calling a `write`/`deploy`/`rollback`/`admin` endpoint with a read-only key; acting on a resource the key is not scoped to (e.g. a site-scoped key touching a sibling site); attempting to broaden a key's scopes via `PATCH /api/keys/{keyId}` (scopes can only be narrowed).
- **remediate**: check the required scope on the endpoint's row in [api-surface.md](../../dev/active/roost-public-api/reference/api-surface.md). mint a key with the needed scope (`POST /api/keys`) — never broaden an existing one. call `GET /api/whoami` to see what the current key carries.

```json
{
  "type": "https://roost.dev/errors/scope-insufficient",
  "title": "Scope insufficient",
  "status": 403,
  "detail": "this key carries roost:roost_lobby_td:read; roost:roost_lobby_td:deploy is required to trigger a rollout",
  "code": "scope_insufficient",
  "required": "roost:roost_lobby_td:deploy",
  "doc_url": "https://owlette.app/docs/api/errors#scope_insufficient",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `site_isolation_violation`

- **http status**: 403 Forbidden
- **meaning**: the request attempted to cross a site boundary in a way the platform prohibits regardless of scope.
- **triggers**: minting a download url for a chunk in a site the caller's key does not belong to; publishing a manifest whose `siteId` does not match the resource path's implicit site; mounting a chunk from a source roost in a different site than the target roost.
- **remediate**: verify the `siteId` in the request body matches the resource you are addressing. cross-tenant chunk reuse is intentional — cross-site chunk reuse within the same tenant is allowed via `POST /api/chunks/{digest}/mount`, but cross-tenant reuse is not supported and never will be.

```json
{
  "type": "https://roost.dev/errors/site-isolation-violation",
  "title": "Site isolation violation",
  "status": 403,
  "detail": "chunk sha256:2e7d2c03... belongs to site lobby-nyc; cannot mount into roost roost_kiosk_v2 which belongs to site kiosk-fleet-01",
  "code": "site_isolation_violation",
  "param": "siteId",
  "doc_url": "https://owlette.app/docs/api/errors#site_isolation_violation",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `token_expired`

- **http status**: 401 Unauthorized
- **meaning**: the credential was valid at some point but has passed its `expiresAt` or been revoked.
- **triggers**: presenting a key whose `expiresAt` is in the past; presenting a rotated key past its 24h grace window; presenting a key that has been `DELETE`d.
- **remediate**: mint a fresh key (`POST /api/keys`) or rotate the existing one (`POST /api/keys/{keyId}/rotate`). treat expiration as a normal lifecycle event — rotate on a schedule well before `expiresAt`.

```json
{
  "type": "https://roost.dev/errors/token-expired",
  "title": "Token expired",
  "status": 401,
  "detail": "api key key_01HXYZA7F3B2C1D0E9F8G7H6J5 expired at 2026-04-20T15:30:00Z",
  "code": "token_expired",
  "doc_url": "https://owlette.app/docs/api/errors#token_expired",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `unsupported_version`

- **http status**: 400 Bad Request
- **meaning**: the `Roost-Version` header specified a date the server does not recognise or has retired.
- **triggers**: typo in the header value; pinned to a retired version; copied a version date from an unrelated product.
- **remediate**: query `GET /api/version` for the list of currently `supported`, `deprecated`, and `retired` dates. deprecated versions still work (with a warning header) — retired ones do not. pin to the `current` date if you have no reason to pin older.

```json
{
  "type": "https://roost.dev/errors/unsupported-version",
  "title": "Unsupported version",
  "status": 400,
  "detail": "Roost-Version 2024-01-01 is not a recognized api version; supported: [2026-04-22]",
  "code": "unsupported_version",
  "param": "Roost-Version",
  "doc_url": "https://owlette.app/docs/api/errors#unsupported_version",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

### `validation_failed`

- **http status**: 400 Bad Request
- **meaning**: the request body, query, or headers failed schema validation.
- **triggers**: missing required field; wrong type; value out of range (e.g. `ttlDays > 365`, `graceHours > 72`, `page_size > 100`, hash batch size > 1000); malformed sha-256 digest; illegal chars in a roost name; unknown enum value (strategy, event kind, scope resource); `scheduleAt` in the past; invalid opaque `page_token`; narrowing scope attempt that actually broadens; url not https for a webhook target.
- **remediate**: read `detail` and `param` for the specific failure. the response may include an `errors{}` object mapping dotted json paths to arrays of validation messages when multiple fields failed at once.

```json
{
  "type": "https://roost.dev/errors/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "ttlDays must be between 1 and 365",
  "code": "validation_failed",
  "param": "ttlDays",
  "errors": {
    "ttlDays": ["ttlDays must be between 1 and 365"],
    "scopes[0].permissions": ["permissions array cannot be empty"]
  },
  "doc_url": "https://owlette.app/docs/api/errors#validation_failed",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

## retry guidance

not every error is retryable. retrying a non-retryable error wastes calls against your rate-limit bucket and can trigger a secondary `rate_limited`.

**safe to retry** (transient — backoff with jitter):
- `429 rate_limited` — honour `Retry-After`, do not add your own delay on top.
- `500 internal_error` — retry up to 3 times with exponential backoff starting at 1s.
- `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout` — same treatment as 500. these are surfaced from the upstream platform (cloudflare, railway) and follow the same retry semantics.

**not safe to retry** (client bug — fix the request):
- every other `4xx` is a client-side problem. retrying will return the same error. fix the payload, the scope, the `If-Match` value, or the credential before retrying.

**use `Idempotency-Key` for safe post retries.**
for any `POST`, `PATCH`, or `DELETE` you retry (whether after a 5xx, a network failure, or a client timeout), attach an `Idempotency-Key: <uuid>` header. the server caches the full response for 24h keyed on `{userId, environment, key, sha256(body)}` — so the retry either returns the cached response (safe) or, if the body has changed, surfaces `idempotency_key_mismatch` (loud failure instead of silent double-effect). without an idempotency key, retrying `POST /api/roosts/{roostId}/deploy` after a timeout can double-trigger a fan-out.

rule of thumb: **always send an `Idempotency-Key` on mutating requests**, not just on retries. the overhead is zero; the upside is retry-safety for free.

---

## request ids

every response — success or failure — carries a `requestId` in the body (on failures) and in the `X-Request-Id` response header (on all responses). the id is an opaque string like `req_01HYCAM5T4P9R1S3U7V8W0X2Y4` and is unique to the request.

- **log it**. store the `X-Request-Id` alongside every request your sdk makes. when something breaks in production, the id is the fastest path from symptom to root cause.
- **include it in support tickets**. when opening a ticket at `support@owlette.app`, always paste the `requestId`. it lets support engineers pull the full request/response transcript, server-side stack trace, and upstream dependency traces in one click — without it, triage starts with "can you reproduce?"
- **follow `request_log_url`** if present. authenticated requests return a `request_log_url` in the error body that deep-links to the dashboard's request log for that id. useful for self-service debugging before you escalate.

request ids survive retries — if you retry an idempotent request, each attempt gets its own id, and server-side correlation preserves the full chain.
