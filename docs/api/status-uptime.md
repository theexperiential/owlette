# status page and uptime checks

**Last updated**: 2026-04-29

External public launch requires a customer-visible status page. The first launch target is an Instatus Starter hosted page, which is free and has enough monitor capacity for the initial component set. The custom domain `https://status.owlette.app` is deferred until a paid custom-domain plan or alternate provider path is approved.

The status page is launch packaging. Developer preview can proceed without it, but external public launch should not.

---

## customer surface

| surface | purpose |
|---|---|
| Instatus hosted page URL | public status page for current health, active incidents, and incident history |
| `https://status.owlette.app` | later custom-domain alias for the public status page |
| `GET /api/version` | unauthenticated API liveness check |
| `GET /api/whoami` | auth-path liveness check; unauthenticated `401` is healthy |
| `GET /api/openapi` | public contract availability check for docs/reference monitoring |
| `GET /docs/api` | rendered API reference availability check |

Do not expose cron routes or vendor credentials to API consumers. Status-ping infrastructure is internal operator tooling and stays out of OpenAPI.

---

## status components

The initial public status page tracks seven components.

| component | health signal |
|---|---|
| dashboard | `GET /` returns 2xx/3xx within 3 seconds |
| API | `GET /api/version` returns 2xx and `GET /api/whoami` returns 401 or 2xx within 2 seconds |
| agent registry | latest machine heartbeat is less than 5 minutes old |
| webhook delivery | last-hour delivery success rate is at least 95 percent when delivery samples exist |
| R2 uploads | placeholder healthy until route-level R2 5xx telemetry is instrumented |
| Firestore | server-side read of `system_status/heartbeat` completes within 500 ms |
| Cortex chat | placeholder healthy until Cortex SSE success-rate telemetry is instrumented |

The placeholder components are explicit so the page can launch with the intended component taxonomy without inventing false precision. Replace each placeholder with real telemetry before publishing SLOs.

---

## operator setup

Synthetic checks run from internal cron infrastructure and publish component state to the hosted status-page vendor after repeated failures or recovery. That operator wiring is documented in [web deployment](../setup/web-deployment.md) and [environment variables](../setup/environment-variables.md).

Do not put cron URLs, vendor API keys, component ids, or Firestore collection names in customer handoff material.

---

## incident policy

Operators publish incidents manually. A synthetic check can degrade a component, but it should not create an incident by itself.

Publish an incident when a customer would reasonably notice the issue:

- API 5xxs, auth failures, or severe latency affect more than one customer
- docs/reference outage blocks integration work
- webhook delivery drops below the launch threshold
- agent registry or Firestore degradation makes machine status unreliable
- Cortex chat is unavailable for public API users

Use this update template:

```text
We are currently investigating <issue>.
Impact: <who/what is affected>.
Next update: <time, usually 15 minutes from now>.
```

Mark the incident resolved when the underlying issue is fixed. Monitoring can remain elevated while the incident is in `monitoring`.

During the public API launch window, pair incidents with the [public launch runbook](launch-runbook.md) so support ownership, rollback ownership, and first-week monitoring are recorded in the launch ticket.

---

## launch gate

5.1 is externally complete when:

- an Instatus Starter hosted page URL is live and customer-visible
- the seven components exist on the status page
- the 60-second uptime checks are running
- the API component flips degraded after two consecutive `/api/version` or `/api/whoami` failures
- the API component flips operational after recovery
- an operator can publish and resolve a test incident from the vendor UI

The custom domain `status.owlette.app` remains a later launch-polish task because Instatus Starter does not include custom domains. Until the hosted page and vendor setup are complete, treat status-page work as launch-blocked but not developer-preview-blocked.
