# status page — plan
**Last updated**: 2026-04-26 | **Estimated**: 4-6 days | **Vendor**: instatus

ship a public status page at `status.owlette.app` showing component health + active incidents. see [context.md](context.md) for design + decisions; [reference/instatus-config.md](reference/instatus-config.md) for vendor setup details (created in wave 1).

---

## wave structure

```
wave 1   vendor setup + dns                              (~ 1 day, user-action required)
  ├─ 1.1  instatus account + 7 components defined
  ├─ 1.2  custom subdomain status.owlette.app
  └─ 1.3  reference doc with component ids + webhook urls

wave 2   synthetic healthchecks + cron                   (~ 2 days)
  ├─ 2.1  healthcheck module per component
  ├─ 2.2  status-ping cron route (60s)
  ├─ 2.3  state-change webhook poster
  └─ 2.4  unit tests for the healthcheck functions

wave 3   integration + polish                            (~ 1 day)
  ├─ 3.1  footer link
  ├─ 3.2  changelog entry
  ├─ 3.3  runbook for publishing incidents
  └─ 3.4  end-to-end test (simulate outage → confirm)
```

---

## wave 1 — vendor setup + dns

**duration**: ~1 day. user-action heavy: requires creating an instatus account and adding a dns record. nothing to /execute autonomously.

### 1.1 — instatus account + 7 components defined
sign up at instatus.com on the $20/mo "starter" plan. create the 7 components from context.md (dashboard, api, agent registry, webhook delivery, r2 uploads, firestore, cortex chat). leave incident history empty.

### 1.2 — custom subdomain status.owlette.app
configure custom domain in instatus admin. add the cname record at the dns provider (cloudflare, godaddy, wherever owlette.app's dns is managed). wait for ssl provisioning (usually <10min).

### 1.3 — reference doc
record component ids + status update endpoint details in `reference/instatus-config.md` so the wave-2 cron knows where to post.

---

## wave 2 — synthetic healthchecks + cron (autonomous)

**duration**: ~2 days. all code work; depends on wave 1 reference doc landing.

Public API W5.1 has landed the autonomous foundation early: `web/lib/healthChecks.server.ts`, `web/lib/instatusClient.ts`, `web/app/api/cron/status-ping/route.ts`, focused tests, and `docs/api/status-uptime.md`. Keep the wave-2 tasks open until the Instatus page id/component ids exist, the 60-second cron is configured, and a degraded/recovered state change is verified against the live status page.

### 2.1 — healthcheck module
new `web/lib/healthChecks.server.ts`. one async function per component, all returning `{component: string, ok: boolean, latency_ms: number, error?: string}`. specifics:
- `dashboard()` — http GET `https://owlette.app/`, expect 200 within 3s
- `api()` — http GET `https://owlette.app/api/whoami` with a dedicated read-only api key, expect 401 (unauth — proves the endpoint is alive without needing valid auth) within 2s
- `agentRegistry()` — read latest doc from `sites/*/machines/*` ordered by `lastHeartbeat` desc, confirm at least one heartbeat within 5min (proves the ingest pipeline is processing)
- `webhookDelivery()` — query `webhook_deliveries` for last hour, compute success_rate; ok if ≥95%
- `r2Uploads()` — call existing internal r2 health probe (or read `r2_health` collection if it exists); fall back to "ok if no 5xx in last 10min from chunk-upload routes"
- `firestore()` — measure read latency on a known small doc; ok if p99 (or single sample) ≤500ms
- `cortexChat()` — measure last hour's sse stream success rate from the cortex audit log; ok if ≥95%

### 2.2 — status-ping cron route
new `web/app/api/cron/status-ping/route.ts`. railway cron entry calls it every 60s with the standard `X-Cron-Secret` header. handler runs all 7 healthchecks in parallel (`Promise.all`), writes a row to `status_pings/{tsMillis}` with the results, computes per-component current state.

### 2.3 — state-change webhook poster
in the cron handler, compare current state vs the most recent ping. if any component changed (ok→degraded or degraded→ok), call the Instatus component-status API for that component:
- `PUT https://api.instatus.com/v1/components/{componentId}` with body `{status: 'OPERATIONAL' | 'DEGRADEDPERFORMANCE' | 'PARTIALOUTAGE' | 'MAJOROUTAGE'}` by default; override with `INSTATUS_COMPONENT_STATUS_URL_TEMPLATE` if the vendor account uses a different component endpoint shape.
- bearer-auth using an instatus api key stored in railway env as `INSTATUS_API_KEY`.
- swallow webhook failures (log + continue) — never let instatus being down cause our healthcheck cron to fail.

### 2.4 — unit tests
new `web/__tests__/lib/healthChecks.test.ts`. mock fetch + firestore. cover:
- each healthcheck returns ok when its underlying source returns expected
- each healthcheck returns degraded with latency_ms recorded when source is slow
- each healthcheck returns degraded with error string when source throws
- the state-change comparison correctly detects flips and skips when state is unchanged

---

## wave 3 — integration + polish

**duration**: ~1 day.

### 3.1 — footer link
add "system status" link to the global footer pointing at `https://status.owlette.app`. lowercase per ui copy convention. visible on dashboard + marketing pages.

### 3.2 — changelog entry
add unreleased section to `docs/changelog.md`: "added status page at status.owlette.app showing component health, active incidents, and 90-day uptime history."

### 3.3 — runbook
new `dev/active/status-page/reference/runbook.md`. one page covering:
- when to publish an incident (oncall judgment — "if a customer would notice, publish")
- how to publish from instatus admin (login url, dashboard, "create incident" button)
- standard incident-update template ("we are currently investigating X. impact: Y. eta: Z. next update: ZZ.")
- when to mark resolved (when the underlying issue is fixed, even if monitoring is still elevated)
- weekly review cadence (oncall reviews past week's incidents, files postmortems if anything ≥30min)

### 3.4 — end-to-end test
manual test:
1. confirm `status.owlette.app` is live and shows all 7 components green
2. set `RATE_LIMIT_FORCE_503=true` in railway env to simulate api outage
3. wait 2 ping cycles (~2min); confirm the api component flips to degraded on the public page
4. unset the env var; confirm the component flips back to operational within 2 minutes
5. publish a test incident via the instatus admin ui; confirm it appears on the page within 30 seconds
6. resolve the test incident

---

## risks

- **instatus api flakiness**: if Instatus component-status updates fail, our state changes won't propagate. mitigation: cron logs and returns publish failures without blocking local ping writes; we'd see a stuck-stale state on the public page until the next successful state change goes through. acceptable v1 trade-off.
- **synthetic check false positives**: railway cron running on a single region could see transient network blips that customers don't experience. mitigation: require 2 consecutive failures before flipping a component to degraded (state-change logic in 2.3).
- **api healthcheck triggers rate limit**: 60s cron pings could cumulatively trip the api rate limiter. mitigation: dedicated read-only api key with elevated rate limit, OR allowlist the cron's source ip in `withRateLimit` middleware.
- **webhook delivery / r2 healthchecks not yet instrumented**: 2.1 spec assumes these signals exist. if they don't, scope the initial healthcheck for those components down to "always ok" with a // TODO until the underlying signal is added (separate plan).

## dependencies + ordering

**blocks**: nothing currently in `dev/active/`. shipping this strengthens the public api launch story (api-sprint + roost-public-api consumers benefit), but neither plan depends on it.

**blocked by**:
- wave 1 needs user action (instatus account creation + dns record). cannot be `/execute`'d autonomously.
- wave 2 depends on wave 1 reference doc.
- public API W5.1 code can record local pings before wave 1, but external incident visibility remains blocked until `status.owlette.app` resolves and component ids are configured.

## success criteria

per [context.md](context.md):
1. `status.owlette.app` resolves with 7 components.
2. api 5xx → component flips to degraded within 2 minutes.
3. operator publishes incident in <2 minutes.
4. footer link from owlette.app + dev.owlette.app.
5. email subscribers notified within 1 minute.
6. e2e test (simulate outage → confirm) passes per 3.4.
