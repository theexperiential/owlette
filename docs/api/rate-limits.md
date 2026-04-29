# rate limits and quotas

**Last updated**: 2026-04-28

Owlette enforces two related limits:

- **Quota**: slower plan limits such as storage, bandwidth, daily publishes, webhook deliveries, active keys, or deployment targets.
- **Rate limits**: faster request or concurrency limits that protect the API and fleet control plane.

A correct client handles both. Being below storage quota does not guarantee a bursty script can ignore `429`, and being below request rate does not guarantee a publish can exceed the site's plan quota.

---

## quota vs rate limit

| dimension | quota | rate limit |
|---|---|---|
| common status | `402 quota_exceeded` | `429 rate_limited` |
| time scale | monthly, daily, or resource lifecycle | seconds, minutes, or active concurrency |
| fix | reduce usage, wait for reset, or upgrade tier | back off, reduce concurrency, or shard independent traffic |
| stable signal | problem `code` and quota fields | `RateLimit-*`, `Retry-After`, and reason headers when available |

Quota refusals do not change state. Rate-limit refusals do not mean the key is banned; they mean the caller should slow down for the bucket that tripped.

---

## rate-limit headers

Responses that pass through a public rate limiter include these headers when the active limiter can report counters:

| header | meaning |
|---|---|
| `RateLimit-Limit` | Window limit for the active bucket. |
| `RateLimit-Remaining` | Requests remaining in the current window. |
| `RateLimit-Reset` | Seconds until the window resets. |

For compatibility, some routes also emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

On `429`, responses include:

| header | meaning |
|---|---|
| `Retry-After` | Seconds to wait before retrying. Prefer this over client-side guesses. |
| `Roost-Rate-Limited-Reason` | Bucket class that tripped. |

Valid `Roost-Rate-Limited-Reason` values:

| value | meaning | response |
|---|---|---|
| `global-rate` | Shared global or tenant-level burst protection. | Back off globally. |
| `endpoint-rate` | Endpoint, route family, or IP bucket exhausted. | Reduce concurrency for that route family. |
| `key-rate` | API-key bucket exhausted. | Slow this integration or split independent workloads across separate scoped keys. |
| `site-concurrency` | Site-level concurrent work limit reached. | Wait for in-flight rollout, command, or deployment work to finish. |

Some streaming, compatibility, and internal routes may omit rate-limit headers. Treat them as useful signals when present, not as fields guaranteed on every response.

---

## example 429

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
RateLimit-Limit: 1000
RateLimit-Remaining: 0
RateLimit-Reset: 47
Retry-After: 47
Roost-Rate-Limited-Reason: key-rate

{
  "type": "https://owlette.app/problems/rate-limited",
  "title": "rate limited",
  "status": 429,
  "detail": "Too many requests. Please try again in 47 seconds.",
  "code": "rate_limited",
  "retryAfter": 47,
  "docsUrl": "https://owlette.app/docs/api/errors#rate_limited",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y0"
}
```

Clients should read `Retry-After` from the header first. The problem body's `retryAfter` field mirrors the same idea for JSON-only error handlers.

---

## retry guidance

Retry:

- `429 rate_limited`, honoring `Retry-After`.
- `500`, `502`, `503`, and `504` with exponential backoff and jitter.
- Network failures and client timeouts when the original request included an `Idempotency-Key`.

Do not blindly retry:

- `400`, `401`, `403`, `404`, `409`, `412`, or `422`.
- `402 quota_exceeded` unless usage changed or the plan was upgraded.
- `422 idempotency_key_mismatch`; fix the key/body mismatch first.

Recommended fallback when `Retry-After` is absent:

```text
delay_ms = min(60000, 500 * 2 ** attempt) * random(0.5, 1.0)
```

Use at most 6 attempts for interactive requests. Background jobs can retry longer, but should log `requestId`, status, `code`, and the rate-limit headers for each attempt.

---

## idempotency and retries

Every retried mutation should include an `Idempotency-Key`. Many public mutating endpoints require it. Reusing the same key for an identical retry lets Owlette return the original successful response instead of executing the side effect again.

See [idempotency.md](idempotency.md) for the 24-hour replay window, mismatch behavior, and `Idempotent-Replayed` header.

---

## quota checks

Use quota endpoints before large writes when you can:

```http
GET /api/sites/{siteId}/quota HTTP/1.1
Authorization: Bearer owk_live_...
```

Typical quota snapshots include:

```json
{
  "siteId": "kiosk-fleet-01",
  "tier": "pro",
  "usedBytes": 23456789012,
  "pendingBytes": 104857600,
  "limitBytes": 107374182400
}
```

The API compares committed and pending usage against the active plan limit. In-flight upload reservations may count as pending usage until they are finalized or expire.

---

## client rules

- Use one scoped key per integration so rate-limit and audit signals are attributable.
- Pace bulk writes with a small concurrency limit before raising it.
- Prefer fewer, larger batch requests where endpoints support batching.
- Keep `page_size` at or below the documented maximum when exporting collections.
- Log `X-Request-Id` and problem `requestId` for failed requests.

---

## see also

- [errors.md](errors.md) for `rate_limited` and `quota_exceeded`.
- [idempotency.md](idempotency.md) for safe mutation retries.
- [pagination.md](pagination.md) for collection traversal.
- The rendered reference at `/docs/api` for operation-level response headers.
