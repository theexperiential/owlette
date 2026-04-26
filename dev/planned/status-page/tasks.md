# status page — tasks
**Progress**: 0/11 complete

each task names files, what to do, and what "done" looks like. waves correspond to [plan.md](plan.md). vendor + design decisions in [context.md](context.md).

---

## wave 1: vendor setup + dns (USER ACTION REQUIRED)

- [ ] **Task 1.1: instatus account + 7 components**
  - Files: (none — vendor admin ui)
  - Do: sign up at instatus.com on the $20/mo "starter" plan. create the 7 components from context.md exactly: `dashboard`, `api`, `agent registry`, `webhook delivery`, `r2 uploads`, `firestore`, `cortex chat`. set initial state to operational on all. note each component's id (instatus shows it in the url or admin ui).
  - Done when: 7 components visible on the instatus admin dashboard, all green.

- [ ] **Task 1.2: custom subdomain status.owlette.app**
  - Files: (none — vendor admin ui + dns provider)
  - Do: in instatus admin → settings → custom domain, enter `status.owlette.app`. instatus will show a cname target. add a cname record at the dns provider managing owlette.app (cloudflare/godaddy/etc) pointing `status` → instatus's target. wait for ssl provisioning (<10min typical).
  - Done when: `https://status.owlette.app` loads and shows the 7 components green with valid ssl.

- [ ] **Task 1.3: reference doc with component ids + webhook urls**
  - Files: `dev/active/status-page/reference/instatus-config.md` (new)
  - Do: record each component's id, the page id, the incoming-webhook base url, and the instatus api key (don't paste the key — just note its env var name `INSTATUS_API_KEY` and where to find it in railway). include the exact status enum values the api accepts (`OPERATIONAL`, `DEGRADEDPERFORMANCE`, `PARTIALOUTAGE`, `MAJOROUTAGE`).
  - Done when: a fresh engineer can write the wave-2 cron handler from this doc + the instatus api docs alone.

---

## wave 2: synthetic healthchecks + cron (autonomous)

- [ ] **Task 2.1: healthcheck module per component**
  - Files: `web/lib/healthChecks.server.ts` (new), `web/__tests__/lib/healthChecks.test.ts` (new — partial; full coverage in 2.4)
  - Do: export 7 async functions matching the components. each returns `{component: string, ok: boolean, latency_ms: number, error?: string}`. specifics:
    - `dashboardHealth()` — fetch `https://owlette.app/` 3s timeout, ok if 200
    - `apiHealth()` — fetch `https://owlette.app/api/whoami` 2s timeout, ok if 401 (proves alive without auth)
    - `agentRegistryHealth()` — query `sites/*/machines/*` ordered by `lastHeartbeat` desc limit 1; ok if any heartbeat in last 5min
    - `webhookDeliveryHealth()` — query `webhook_deliveries` last hour; ok if success_rate ≥95%
    - `r2UploadsHealth()` — call existing r2 health probe if present, else placeholder returning `{ok: true}` with a `// TODO: instrument r2 5xx tracking` comment
    - `firestoreHealth()` — read a known small doc (e.g. `system_status/heartbeat`); ok if latency ≤500ms
    - `cortexChatHealth()` — query last hour's cortex audit log for sse stream success; ok if ≥95%, placeholder `{ok: true}` with TODO if signal isn't instrumented yet
  - Done when: all 7 functions importable and return the expected shape; partial test coverage proves at least one ok-path + one fail-path per function.

- [ ] **Task 2.2: status-ping cron route**
  - Files: `web/app/api/cron/status-ping/route.ts` (new), `railway.json` or equivalent cron config (existing — add entry)
  - Do: route handler verifies `X-Cron-Secret` header (existing pattern from `/api/cron/display-alerts` etc), runs all 7 healthchecks via `Promise.all`, writes a row to firestore `status_pings/{Date.now()}` with the results array. add a railway cron entry for every-60s.
  - Done when: hitting the route with the cron secret produces a `status_pings/*` doc with 7 result entries; railway cron is configured to fire every 60s.

- [ ] **Task 2.3: state-change webhook poster**
  - Files: `web/app/api/cron/status-ping/route.ts` (extend), `web/lib/instatusClient.ts` (new — small wrapper)
  - Do: in the cron handler after writing the new ping, read the previous ping (`status_pings` ordered by id desc, limit 2). compare per-component state. for any component whose `ok` flipped, call `instatusClient.setComponentStatus(componentId, status)` which posts to `https://api.instatus.com/v1/{pageId}/components/{componentId}` with bearer auth (`INSTATUS_API_KEY` env var). map ok→`OPERATIONAL`, !ok→`DEGRADEDPERFORMANCE` (ramp to `PARTIALOUTAGE` / `MAJOROUTAGE` only when oncall manually escalates). require 2 consecutive failures before flipping degraded (skip the post if previous state was already operational and only the latest ping is failing). swallow webhook errors with a log entry — never throw.
  - Done when: synthetic outage (force a healthcheck to return `{ok: false}`) results in instatus showing the component degraded within 2 ping cycles (~2min); restoring the source flips it back within the same window.

- [ ] **Task 2.4: full unit tests for healthchecks + cron**
  - Files: `web/__tests__/lib/healthChecks.test.ts` (extend from 2.1), `web/__tests__/api/cron/status-ping.test.ts` (new)
  - Do: cover for each healthcheck: ok path, slow path (degraded with latency recorded), throwing path (degraded with error string). cover for the cron handler: full happy path, 1-flip-detected path, no-flip path (state unchanged → no webhook posts), webhook-failure-doesnt-throw path, missing-cron-secret path (401).
  - Done when: ≥20 test cases pass; mocking strategy uses jest.fn for fetch + a fake firestore admin doc.

---

## wave 3: integration + polish

- [ ] **Task 3.1: footer link**
  - Files: `web/components/Footer.tsx` (or wherever the global footer lives — grep `<footer` if unsure)
  - Do: add an inline link "system status" pointing at `https://status.owlette.app`. lowercase. external link (opens in new tab). slot it next to the existing terms/privacy/changelog links.
  - Done when: link visible on dashboard pages + marketing pages; click opens status page in new tab.

- [ ] **Task 3.2: changelog entry**
  - Files: `docs/changelog.md`
  - Do: add unreleased section entry: `### added — public status page`. one paragraph: "owlette now publishes system health at status.owlette.app. seven components tracked (dashboard, api, agent registry, webhook delivery, r2 uploads, firestore, cortex chat) with synthetic uptime checks every 60 seconds. operators publish incident updates from the instatus admin ui; subscribers can opt in to email or webhook notifications."
  - Done when: changelog entry committed + dashboard footer link committed in the same change.

- [ ] **Task 3.3: incident publishing runbook**
  - Files: `dev/active/status-page/reference/runbook.md` (new)
  - Do: one-page runbook covering — (1) when to publish (oncall judgment: if a customer would notice, publish), (2) how to publish (login url, "create incident" button, severity choice), (3) standard update template ("we are currently investigating X. impact: Y. eta: Z. next update at Z+15min."), (4) when to mark resolved (when underlying issue is fixed; monitoring may stay elevated), (5) postmortem trigger (any incident ≥30min duration).
  - Done when: runbook lives in reference/; linked from both context.md and the dashboard's internal "oncall handbook" if one exists.

- [ ] **Task 3.4: end-to-end test**
  - Files: (none — manual test, log results in this task description)
  - Do: 
    1. confirm `status.owlette.app` loads and shows 7 green components.
    2. set `RATE_LIMIT_FORCE_503=true` (or equivalent — add a feature flag if needed) in railway env to force `/api/whoami` to 503.
    3. wait 2 ping cycles (~2min); confirm the api component flips to degraded on the public page.
    4. unset the env var; confirm the component flips back to operational within 2min.
    5. publish a test incident via the instatus admin ui; confirm it appears on the public page within 30s. resolve the test incident.
    6. record results inline in the log section below.
  - Done when: all 6 steps pass; results recorded in tasks.md log.

---

## log

### 2026-04-26
- Plan created. Vendor: instatus ($20/mo). Subdomain: status.owlette.app. 7 components: dashboard, api, agent registry, webhook delivery, r2 uploads, firestore, cortex chat. Synthetic uptime via railway cron every 60s. Manual incident publishing (no auto-detection). Wave 1 requires user action (instatus signup + dns). Waves 2-3 are autonomous after wave 1 lands.
