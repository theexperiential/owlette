# errors

**Last updated**: 2026-05-01

Public API errors use `application/problem+json`. Clients should branch on the stable `code` field, not on human-readable `detail` text.

---

## envelope

```json
{
  "type": "https://owlette.app/problems/validation-failed",
  "title": "validation failed",
  "status": 400,
  "detail": "page_size must be a positive integer",
  "code": "validation_failed",
  "errors": {
    "query.page_size": ["must be a positive integer <= 100"]
  },
  "docsUrl": "https://owlette.app/docs/api/errors#validation_failed",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

| field | meaning |
|---|---|
| `type` | Stable URI for the problem class. |
| `title` | Short human-readable category. |
| `status` | HTTP status code, matching the response status. |
| `detail` | Occurrence-specific explanation. Safe to show, but not stable for parsing. |
| `code` | Stable machine-readable error code. Use this for client branching. |
| `docsUrl` | Documentation anchor for the code. |
| `requestId` | Correlation id. Also emitted as `X-Request-Id` on problem responses. |
| `param` | Optional offending header, query parameter, path parameter, or body field. Many validation responses omit it. |
| `errors` | Optional field-level validation map keyed by dotted path. This is the common validation shape. |

Unknown fields are forward-compatible extensions. Ignore fields you do not recognize.

---

## codes

| code | status | meaning | client action |
|---|---:|---|---|
| `unauthorized` | 401 | Missing, malformed, unknown, or unsupported credential. | Send a supported credential and retry. |
| `token_expired` | 401 | API key expired or rotated value is past its grace window. | Rotate or create a new key. |
| `forbidden` | 403 | Authenticated caller lacks role, site membership, or platform capability. | Use a different caller or change access in the dashboard. |
| `scope_insufficient` | 403 | API key lacks the exact resource/id/permission required. | Create or use a key with the required scope. |
| `not_found` | 404 | Resource is absent or hidden from this caller. | Check the id and caller scope. |
| `version_not_found` | 404 | A version id, version ref, or version alias did not resolve in the roost history. | Check the roost id, site id, and version ref before retrying. |
| `validation_failed` | 400 | Body, query, path, or header validation failed. | Fix the request using `detail` and `errors`. |
| `unsupported_version` | 400 | `Roost-Version` was present but is not one of the supported API dates. | Use a date from the response `supported` list or from `GET /api/version`. |
| `forbidden_field` | 400 | The request body included fields this operation does not allow. | Remove the listed fields and retry. |
| `version_ref_malformed` | 400 | A `versionRef` or `targetVersion` value did not match an accepted ref form. | Use an alias, positive version number, `vN`/`#N`, or a version id. |
| `version_content_immutable` | 400 | PATCH attempted to change published version content. | Send only mutable fields or publish a new version. |
| `idempotency_key_required` | 400 | Required `Idempotency-Key` header missing or blank. | Retry with a generated key. |
| `idempotency_key_invalid` | 400 | `Idempotency-Key` exceeds 255 characters. | Generate a shorter key. |
| `idempotency_key_mismatch` | 422 | Same key reused on the same route with a different body. | Reuse the original body or generate a new key. |
| `conflict` | 409 | Request conflicts with current resource state. | Read current state and submit a corrected request. |
| `rollback_no_op` | 400 | Rollback target already resolves to the current version. | Choose a different target or treat the request as already applied. |
| `precondition_failed` | 412 | A required server-side precondition failed, such as missing referenced chunks. | Satisfy the precondition and retry. |
| `version_stale` | 412 | `expectedCurrentVersionId` did not match the roost current pointer during publish. | Re-read the roost and retry if the publish is still intended. |
| `payload_too_large` | 413 | Request exceeded an endpoint size limit. | Split the request or reduce payload size. |
| `quota_exceeded` | 402 | Site or account quota would be exceeded. | Free usage, wait for reset, or upgrade. |
| `rate_limited` | 429 | Request or concurrency bucket exhausted. | Honor `Retry-After`; reduce concurrency. |
| `machine_offline` | 409 | Machine command cannot be queued or completed because the target is offline. | Wait for the machine to reconnect or target another machine. |
| `cortex_unavailable` | 400/423/503 | Cortex could not stream because the target was missing, disabled, or offline. | Fix the target/enablement issue or retry after the machine reconnects. |
| `service_unavailable` | 503 | Required dependency is temporarily unavailable. | Retry with backoff. |
| `internal_error` | 500 | Unexpected server error. | Retry with backoff; quote `requestId` if it persists. |

---

## code details

### unauthorized

The request did not carry a usable credential. Send a supported API key, session, or Firebase ID token for the route.

### token_expired

The API key expired, or a rotated key value is past its grace window. Rotate or create a replacement key.

### forbidden

The caller is authenticated but lacks the required role, site membership, ownership, or platform capability.

### scope_insufficient

The API key is valid but lacks the exact resource, id, and permission required by the operation.

### not_found

The resource does not exist or is intentionally hidden from this caller to avoid leaking resource existence.

### version_not_found

A version id, numeric ref, alias, or version path parameter did not resolve within the requested roost history.

### validation_failed

The request body, query, path, or headers failed validation. Use `detail` and `errors` to fix the request. Some routes also include `param`.

### unsupported_version

The `Roost-Version` header was present but is not supported by the server. The response includes `sent` and `supported` fields.

### forbidden_field

The request body included fields that are not accepted by that operation, such as extra fields on public Cortex send or rename requests.

### version_ref_malformed

A version reference did not match the accepted resolver grammar: aliases such as `current`, positive version numbers, `vN` or `#N`, or a version id.

### version_content_immutable

Published version content is immutable. Patch only the fields that the endpoint allows, or publish a new version.

### idempotency_key_required

The operation requires `Idempotency-Key`; retry the same mutation with a generated key.

### idempotency_key_invalid

The `Idempotency-Key` header is syntactically invalid, currently because it exceeds 255 characters.

### idempotency_key_mismatch

The same `Idempotency-Key` was reused on the same route with a different request body. Reuse the original body or generate a new key.

### conflict

The request conflicts with current resource state and will not succeed until the payload or target state changes.

### rollback_no_op

The rollback target resolves to the version that is already current, so the request would not change the roost pointer.

### precondition_failed

A route-specific precondition failed. Current examples include publishing a version that references chunks missing from R2.

### version_stale

A publish request included `expectedCurrentVersionId`, but the roost current pointer changed before the transaction committed.

### payload_too_large

The request body exceeded an endpoint size limit. Split or reduce the payload.

### quota_exceeded

The request would exceed a site, account, storage, bandwidth, or lifecycle quota.

### rate_limited

The caller exceeded an active request or concurrency bucket. Honor `Retry-After`.

### machine_offline

The requested machine command cannot proceed because the target machine is offline.

### cortex_unavailable

Cortex could not stream for the requested conversation because the target was invalid, disabled, or offline.

### service_unavailable

A required dependency is temporarily unavailable. Retry with backoff.

### internal_error

An unexpected server error occurred. Retry with backoff and quote `requestId` if the problem persists.

Route-specific validation codes may appear for narrow input failures, for example `invalid_body`, `invalid_enabled`, or resource-specific constraints. They use the same envelope and are documented on the operation when part of the public contract.

---

## retry rules

Retry with backoff:

- `429 rate_limited`
- `500 internal_error`
- `502`, `503`, or `504` platform/upstream failures
- network failures or client timeouts when the original mutation included an `Idempotency-Key`

Do not blindly retry:

- auth failures (`401`, `403`)
- missing resources (`404`)
- validation/idempotency mismatch failures (`400`, `422`)
- quota failures (`402`) unless usage or plan state changed
- precondition failures (`409`, `412`) until you have refreshed state

For mutating retries, reuse the same `Idempotency-Key` only when the request method, path, query, and body are identical. See [idempotency.md](idempotency.md).

---

## request ids

Problem responses include `requestId` in the body and `X-Request-Id` in the response headers. Log both the status/code and request id for failed requests.

Each retry attempt can have a different request id. If an idempotent retry replays a cached success, the response also includes `Idempotent-Replayed: true`.

---

## examples

### scope failure

```json
{
  "type": "https://owlette.app/problems/scope-insufficient",
  "title": "insufficient scope",
  "status": 403,
  "detail": "insufficient scope: requires write on machine:machine_123",
  "code": "scope_insufficient",
  "required": {
    "resource": "machine",
    "id": "machine_123",
    "permission": "write"
  },
  "docsUrl": "https://owlette.app/docs/api/errors#scope_insufficient",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

### idempotency mismatch

```json
{
  "type": "https://owlette.app/problems/validation-failed",
  "title": "idempotency key mismatch",
  "status": 422,
  "detail": "Idempotency-Key '7c55c5de-7ec6-4c63-a1c8-94e13c56f962' was previously used with a different request body; reuse requires the identical body",
  "code": "idempotency_key_mismatch",
  "docsUrl": "https://owlette.app/docs/api/errors#idempotency_key_mismatch",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

### rate limited

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
Roost-Rate-Limited-Reason: key-rate
Content-Type: application/problem+json
```

```json
{
  "type": "https://owlette.app/problems/rate-limited",
  "title": "rate limited",
  "status": 429,
  "detail": "Too many requests. Please try again in 17 seconds.",
  "code": "rate_limited",
  "retryAfter": 17,
  "docsUrl": "https://owlette.app/docs/api/errors#rate_limited",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

---

## see also

- [authentication.md](authentication.md) for auth and scope errors.
- [pagination.md](pagination.md) for pagination validation.
- [idempotency.md](idempotency.md) for replay and mismatch behavior.
- [rate-limits.md](rate-limits.md) for `Retry-After` and rate-limit headers.
