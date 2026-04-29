# Owlette API overview

The Owlette public API lets you automate fleet operations from scripts, CI, internal tools, and SDKs. Use it to inspect sites and machines, queue machine commands, manage installer deployments, publish Roost content, run Cortex diagnostics, manage webhooks, and read operational logs.

The dashboard and API operate on the same underlying resources. Use the dashboard for exploration and one-off admin work; use the API when the workflow should be repeatable, audited, or integrated into another system.

---

## base URLs

| environment | base URL |
|---|---|
| production | `https://owlette.app` |
| developer preview | `https://dev.owlette.app` |
| local development | `http://localhost:3000` |

Public API paths are rooted at `/api`. The rendered endpoint reference is available at `/docs/api`, with raw OpenAPI JSON at `/api/openapi`.

---

## core resources

| resource | purpose |
|---|---|
| sites | tenant boundary for machines, quotas, logs, webhooks, deployments, and Roost content |
| machines | Windows agents registered to a site |
| commands | async work queued to a machine, such as screenshots or process actions |
| deployments | classic installer fan-out records and per-target status |
| Roosts | content-addressed project bundles, versions, chunks, rollouts, and rollback |
| Cortex | site and machine diagnostics over `/api/cortex/conversations` |
| webhooks | outbound event subscriptions and delivery history |
| API keys | scoped credentials for automation |

---

## shared conventions

- **Authentication** uses scoped `owk_live_*` and `owk_test_*` API keys in `Authorization: Bearer ...`; dashboard and setup flows may use Firebase ID tokens or sessions. See [authentication](authentication.md).
- **Errors** use `application/problem+json` with stable `code`, `docsUrl`, and `requestId` fields. See [errors](errors.md).
- **Pagination** uses `page_size`, `page_token`, and `next_page_token`, with documented compatibility aliases on older routes. See [pagination](pagination.md).
- **Idempotency** uses `Idempotency-Key` for safe retries of mutating requests. See [idempotency](idempotency.md).
- **Rate limits** use `RateLimit-*`, `Retry-After`, and `Roost-Rate-Limited-Reason` headers where the active limiter can report them. See [rate limits](rate-limits.md).

---

## developer path

1. Start with the [quickstart](quickstart.md): create a key, verify auth, list inventory, queue a safe machine command, and poll it.
2. For internal dev/staging rollout, use the [developer-preview checklist](developer-preview-checklist.md) before handing the API to another consumer.
3. Read the shared convention pages: [authentication](authentication.md), [pagination](pagination.md), [idempotency](idempotency.md), [errors](errors.md), and [rate limits](rate-limits.md).
4. Use the [interactive reference](reference.md) for operation-level scopes, parameters, required idempotency headers, and response shapes.
5. Before external public launch, confirm the [status page and uptime checks](status-uptime.md), [load testing and SLOs](load-testing.md), and [SDK/CLI distribution gate](distribution.md).
6. Move to the resource guide you need: [chunks](chunks.md), [versions](versions.md), [cortex](cortex.md), [webhooks](webhooks.md), or the SDK docs for [Node](sdk-node.md) and [Python](sdk-python.md).
