# rate limits and quotas

**Last updated**: 2026-04-22

this document explains how roost meters and throttles api traffic. two systems run in parallel — **quota** (the slow dial, counted in gigabytes and events-per-day) and **rate-limit** (the fast dial, counted in requests-per-second). both must be considered when designing an integration.

---

## 1. quota vs rate-limit

| dimension | quota | rate-limit |
|---|---|---|
| unit | gb of storage, ops per day, bandwidth per month | requests per second / minute |
| window | monthly (storage, bandwidth), daily (publishes, deliveries) | rolling token bucket (per second → per minute) |
| enforcement | `402 quota_exceeded` | `429 rate_limited` |
| tuning lever | upgrade tier | exponential backoff, retry `Retry-After` |
| who fires | billing engine, nightly reconcile | edge middleware on every request |
| webhook event | `quota.warning` (50/80%), `quota.exceeded` (100%) | none — rate-limit is not an event |

**both matter.** a correct client has to handle both: it can be at 5% of monthly storage quota and still get throttled for bursting 2000 chunk uploads in a second; conversely, it can be well under its per-minute budget and still be refused for pushing past the tier's storage cap.

quota headroom is engineered by **choosing the right tier**. rate-limit headroom is engineered by **backoff + concurrency limits** in the client.

---

## 2. pricing tiers

tier limits are architecturally enforced — the server refuses traffic at the boundary, not just displays a warning. billing is monthly; all limits reset on the 1st utc.

| tier | $/machine/mo | storage (gb) | daily version publishes | api requests / minute | webhook deliveries / day |
|---|---|---|---|---|---|
| free | $0 | 5 (hard cap) | 10 | 60 | 500 |
| starter | $8 | 25 (pooled) | 100 | 300 | 5,000 |
| pro | $15 | 100 (pooled) | 1,000 | 1,000 | 50,000 |
| enterprise | $25–40 | 250 or byo bucket | 10,000 | 5,000 | unlimited |

**per-file max** (enforced on version publish): free 100 mb, starter 5 gb, pro 10 gb, enterprise 50 gb.

**overage** (applies to starter/pro only; free refuses, enterprise negotiated): storage overage billed at $0.05/gb/mo (starter) and $0.04/gb/mo (pro).

**byo bucket (enterprise)** — customer supplies an s3-compatible bucket. storage limits apply to the bucket's own quota; roost only enforces api rate-limits and publish cadence.

upgrade via the dashboard billing page — changes take effect on the next api call after the subscription webhook confirms.

---

## 3. rate-limit headers

every response (success or failure) carries the ietf draft-standard headers. they use no `X-` prefix.

| header | meaning | example |
|---|---|---|
| `RateLimit-Limit` | window limit for the bucket that fired | `1000` |
| `RateLimit-Remaining` | calls remaining in the current window | `987` |
| `RateLimit-Reset` | seconds until the window fully resets | `45` |

**on 429 only**, two extra headers are added:

| header | meaning | example |
|---|---|---|
| `Retry-After` | seconds the client should wait before retrying | `47` |
| `Roost-Rate-Limited-Reason` | which bucket tripped | `key-rate` |

`Roost-Rate-Limited-Reason` values:

| value | meaning | remediation |
|---|---|---|
| `global-rate` | tenant-wide burst ceiling hit | narrow concurrency, backoff |
| `endpoint-rate` | one endpoint class (e.g. versions) exhausted | spread calls, parallelize across endpoints |
| `key-rate` | this api key's per-key budget hit | shard traffic across multiple keys |
| `site-concurrency` | too many concurrent rollouts on one site | serialize deploys, wait for in-flight to finish |

**clients must prefer `Retry-After` over their own backoff timer** — the server may grant a longer cool-down during brownouts.

**example 429:**
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
RateLimit-Limit: 1000
RateLimit-Remaining: 0
RateLimit-Reset: 47
Retry-After: 47
Roost-Rate-Limited-Reason: key-rate

{
  "type": "https://owlette.app/errors/rate_limited",
  "code": "rate_limited",
  "status": 429,
  "detail": "per-key quota of 1000 requests/minute exhausted; retry in 47s",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y0"
}
```

---

## 4. per-resource limits

not every endpoint shares the same budget. chunks are the data plane and need headroom for bulk parallel uploads; versions and deployments are low-frequency control-plane operations.

| endpoint class | example paths | pro tier budget | rationale |
|---|---|---|---|
| chunk control plane | `/api/chunks/check`, `/api/chunks/upload-urls`, `/api/chunks/download-urls` | 5,000 req/min | bulk upload staging — clients batch up to 1000 hashes per call |
| chunk data plane (r2) | signed-url `PUT`/`GET` to r2 | bounded by r2 (thousands of req/s) | off our servers; not subject to roost rate-limits |
| versions | `POST /api/roosts/{id}/versions`, `GET .../versions/*` | 60 req/min + daily publish cap | publishes are expensive — fan-out, cas check, audit entry |
| deployments | `POST /api/roosts/{id}/deploy`, `POST .../rollback` | 30 req/min + site-concurrency cap | one in-flight rollout per site recommended |
| reads (lists/details) | `GET /api/roosts`, `GET /api/sites/{id}/machines`, etc. | 1,000 req/min (default) | cheap and cacheable — highest budget |
| webhook deliveries (outbound) | deliveries to subscriber urls | tier-bound (see above) | pacing prevents subscriber brownouts |
| webhook admin | `POST /api/webhooks`, `PATCH`, rotate-secret | 60 req/min | configuration, not hot path |
| audit log | `GET /api/sites/{id}/audit-log` | 120 req/min | export workloads; paginate with cursors |
| sse stream | `GET /api/events/stream` | 2 concurrent streams per key | long-lived; budget is concurrency, not rps |

budgets scale roughly linearly with tier — multiply the pro numbers by ~0.1 (free), ~0.3 (starter), ~5 (enterprise).

---

## 5. recommended backoff

**exponential backoff with jitter** is the default. honour `Retry-After` first; fall back to the formula only when the server omits it.

### formula

```
delay_ms = min(cap, base * 2 ** attempt) * random(0.5, 1.0)
```

with `base = 500ms`, `cap = 60000ms`, up to 6 attempts.

### node (typescript)

```ts
async function withBackoff<T>(fn: () => Promise<Response>, maxAttempts = 6): Promise<T> {
  let attempt = 0;
  while (true) {
    const res = await fn();
    if (res.status !== 429 && res.status < 500) return res.json() as Promise<T>;
    if (attempt >= maxAttempts) throw new Error(`gave up after ${maxAttempts} attempts`);

    const retryAfter = res.headers.get("Retry-After");
    const serverDelayMs = retryAfter ? Number(retryAfter) * 1000 : null;
    const backoffMs = Math.min(60_000, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
    const delayMs = serverDelayMs ?? backoffMs;

    await new Promise((r) => setTimeout(r, delayMs));
    attempt++;
  }
}
```

### python

```python
import random, time
from typing import Callable

def with_backoff(fn: Callable, max_attempts: int = 6):
    attempt = 0
    while True:
        res = fn()
        if res.status_code != 429 and res.status_code < 500:
            return res.json()
        if attempt >= max_attempts:
            raise RuntimeError(f"gave up after {max_attempts} attempts")

        retry_after = res.headers.get("Retry-After")
        server_delay = float(retry_after) if retry_after else None
        backoff = min(60.0, 0.5 * (2 ** attempt)) * random.uniform(0.5, 1.0)
        delay = server_delay if server_delay is not None else backoff

        time.sleep(delay)
        attempt += 1
```

**rules of thumb:**
- never retry a `400`, `401`, `403`, `404`, `409`, or `422` — these are client errors and will not succeed on replay.
- always retry `429` and `5xx` with backoff.
- include an `Idempotency-Key` on every retried `POST`/`PATCH`/`DELETE` so the server can deduplicate.
- cap total retry time at 5 minutes for interactive flows, 24 hours for background jobs.

---

## 6. burst semantics

rate-limits are enforced via a **token bucket** per key/endpoint class. each bucket has two parameters:

- **sustained rate** — the steady-state refill rate (tokens per second).
- **burst ceiling** — the maximum bucket depth, set to **2x the per-minute sustained rate**.

this means a client at rest can **burst up to 2x its per-minute budget in a single second** before being throttled back to the sustained rate. the rationale:

1. **human-scale workloads are bursty.** a ci pipeline publishes 12 versions in 30 seconds, then nothing for an hour. a flat rps ceiling would force artificial pacing for no technical reason.
2. **chunk uploads parallelize.** pushing a 2 gb version means 512 chunk uploads that all want to go at once. a burst window lets them go.
3. **the ietf `RateLimit-*` draft does not distinguish sustained vs burst.** `RateLimit-Limit` reflects the sustained per-window budget; the burst ceiling is a server-internal affordance, not surfaced as a header.

if you exceed the burst ceiling you get throttled to the sustained rate — not banned. `Retry-After` will be short (under 1 second) in this regime. if you keep pushing past the sustained rate for a full minute you will hit the per-minute window limit, at which point `Retry-After` reflects the time to window reset.

---

## 7. checking quota programmatically

**current snapshot:**

```http
GET /api/sites/{siteId}/quota HTTP/1.1
Authorization: Bearer owk_live_...
```

```json
{
  "siteId": "kiosk-fleet-01",
  "tier": "pro",
  "limitBytes": 107374182400,
  "usedBytes": 23456789012,
  "pendingBytes": 104857600,
  "bandwidthLimitBytesPerMonth": 5497558138880,
  "bandwidthUsedBytesThisMonth": 421233491968,
  "alarms": [
    { "threshold": 0.5, "firedAt": "2026-03-10T00:00:00Z" }
  ],
  "periodResetsAt": "2026-05-01T00:00:00Z"
}
```

**fields:**
- `tier` — one of `free`, `starter`, `pro`, `enterprise`.
- `usedBytes` — bytes committed to storage (versions published).
- `pendingBytes` — bytes reserved by in-flight uploads (see §9).
- `limitBytes` — total bytes allowed on the tier.
- `alarms[]` — thresholds that have already fired this period (useful for resuming after a restart without re-firing).
- `periodResetsAt` — when the monthly window resets.

**trend (default 30 days):**

```http
GET /api/sites/{siteId}/quota/history?period=30d HTTP/1.1
```

supported periods: `30d`, `90d`, `365d`. returns one data point per day:

```json
{
  "siteId": "kiosk-fleet-01",
  "period": "30d",
  "points": [
    { "date": "2026-03-24", "usedBytes": 21474836480, "bandwidthBytes": 12884901888 },
    { "date": "2026-03-25", "usedBytes": 21527265280, "bandwidthBytes": 13421772800 }
  ]
}
```

use this to build usage charts or to predict when you will cross an alarm threshold.

---

## 8. quota alarms

subscribe to webhook events for proactive alerting — polling `GET /api/sites/{id}/quota` on a timer works, but webhooks fire the moment a threshold trips.

| event | fires at | payload highlights |
|---|---|---|
| `quota.warning` | 50% and 80% of `limitBytes` | `{ siteId, threshold, usedBytes, limitBytes, tier }` |
| `quota.exceeded` | 100% of `limitBytes` | same shape, plus `blockedAt` timestamp |

create a subscription via `POST /api/webhooks`:

```json
{
  "siteId": "kiosk-fleet-01",
  "url": "https://ops.example.com/roost-quota-alerts",
  "events": ["quota.warning", "quota.exceeded"],
  "description": "pager — fleet ops on-call"
}
```

events are delivered with the standard `Roost-Signature` hmac header; see `docs/api/webhooks.md` for verification. each threshold fires **once per period** — you will not be paged hourly for staying at 81% all month.

---

## 9. what counts

**storage (`usedBytes` + `pendingBytes`):**
- **uploads add to `usedBytes` immediately** once the version is successfully published. counted at the tenant (site) level — a chunk mounted into a second roost via `POST /api/chunks/{digest}/mount` is **not** double-counted.
- **deletions free bytes via nightly gc, not immediately.** when a roost is deleted (or a version is no longer referenced), the chunks enter a **30-day tombstone** window. during that window the bytes still count toward quota. after 30 days, the chunk gc sweep reclaims them.
- **pending reservations count toward quota.** when a client calls `POST /api/chunks/upload-urls`, the server increments `pendingBytes` for the requested hashes. this prevents a racing bulk-upload from bypassing the quota cap. pending reservations **ttl after 24 hours** — if the client never `PUT`s the bytes, the reservation is released automatically.
- **version json itself counts** toward storage (stored in r2, sized in the kb–mb range for normal roosts).
- the sum `usedBytes + pendingBytes` is what the server compares against `limitBytes` for the 402 gate.

**bandwidth:**
- egress (signed `GET` download-urls resolved by agents) counts toward `bandwidthUsedBytesThisMonth`.
- upload bandwidth is free — we do not meter `PUT`s to r2.
- webhook delivery bandwidth is not metered (counted in delivery-count instead).

**operations:**
- daily version publishes counts `POST /api/roosts/{id}/versions` calls (not deploy/rollback pointer flips).
- api requests/minute counts every successful + 4xx response (health checks and 429 retries excluded).
- webhook deliveries/day counts successful + terminally-failed deliveries (in-flight retries count once).

---

## 10. upgrading

usage trending toward the cap?

- **dashboard → billing** — change tier; effective on the next api call after stripe confirms.
- **enterprise / byo bucket** — contact sales via the dashboard billing page for negotiated limits, multi-region, or compliance controls (hipaa/soc2).

downgrades take effect at the **end of the current billing period** to avoid mid-month refusals. if your `usedBytes` exceeds the downgraded tier's cap, no new publishes will succeed until you reduce storage below the new limit.

---

## see also

- `docs/api/errors.md` — all error codes including `rate_limited` and `quota_exceeded`
- `docs/api/webhooks.md` — subscribing to `quota.*` events and signature verification
- `docs/api/idempotency.md` — `Idempotency-Key` is required for safe retries after 429
- `dev/active/roost-public-api/reference/design-principles.md` — principle 10 (rate-limit headers) and tier rationale
