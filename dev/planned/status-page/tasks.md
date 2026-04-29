# status page - tasks

**Progress**: 0/11 complete

Each task names files, what to do, and what "done" looks like. Waves correspond to [plan.md](plan.md). Vendor and design decisions live in [context.md](context.md).

---

## wave 1: vendor setup + dns (USER ACTION REQUIRED)

- [ ] **Task 1.1: Instatus account + 7 components**
  - Files: none; vendor admin UI.
  - Do: sign up at instatus.com on the $20/mo Starter plan. Create the 7 components from context.md exactly: `dashboard`, `api`, `agent registry`, `webhook delivery`, `r2 uploads`, `firestore`, `cortex chat`. Set initial state to operational on all. Note each component id.
  - Done when: 7 components are visible on the Instatus admin dashboard, all green.

- [ ] **Task 1.2: custom subdomain status.owlette.app**
  - Files: none; vendor admin UI and DNS provider.
  - Do: in Instatus admin, configure custom domain `status.owlette.app`. Add the CNAME record at the DNS provider managing `owlette.app`. Wait for SSL provisioning.
  - Done when: `https://status.owlette.app` loads and shows the 7 components green with valid TLS.

- [ ] **Task 1.3: reference doc with component ids**
  - Files: `dev/active/status-page/reference/instatus-config.md` (new).
  - Do: record each component id, the page id, the component-status endpoint template if it differs from the default, and the env var name `INSTATUS_API_KEY`. Do not paste the API key. Include the status enum values accepted by the account (`OPERATIONAL`, `DEGRADEDPERFORMANCE`, `PARTIALOUTAGE`, `MAJOROUTAGE`).
  - Done when: a fresh engineer can configure the status-ping cron from this doc plus the Instatus API docs.

---

## wave 2: synthetic healthchecks + cron (autonomous)

- [ ] **Task 2.1: healthcheck module per component**
  - Files: `web/lib/healthChecks.server.ts`, `web/__tests__/lib/healthChecks.test.ts`.
  - Do: export 7 async functions matching the components. Each returns `{component, ok, latency_ms, error?}`.
  - Done when: all 7 functions are importable and focused tests cover representative ok and failure paths.

- [ ] **Task 2.2: status-ping cron route**
  - Files: `web/app/api/cron/status-ping/route.ts`, hosting cron config.
  - Do: verify `X-Cron-Secret`, run all 7 healthchecks, write a Firestore status ping, and add a 60-second cron job.
  - Done when: hitting the route with the cron secret produces an internal ping row with 7 result entries and the hosting cron fires every 60 seconds.

- [ ] **Task 2.3: state-change component poster**
  - Files: `web/app/api/cron/status-ping/route.ts`, `web/lib/instatusClient.ts`.
  - Do: compare the new ping with the two most recent prior pings. For any component that needs a public state change, call `setInstatusComponentStatus(component, status)`. The default endpoint is `PUT https://api.instatus.com/v1/components/{componentId}` with bearer auth from `INSTATUS_API_KEY`; use `INSTATUS_COMPONENT_STATUS_URL_TEMPLATE` if the account requires a page-aware endpoint. Map ok to `OPERATIONAL` and not-ok to `DEGRADEDPERFORMANCE`. Require two consecutive failures before degrading; mark operational on recovery. Log publish failures and return them in the cron response, but never fail the local ping write because Instatus is unavailable.
  - Done when: a synthetic outage results in Instatus showing the component degraded within 2 ping cycles, and restoring the source flips it back within the same window.

- [ ] **Task 2.4: full unit tests for healthchecks + cron**
  - Files: `web/__tests__/lib/healthChecks.test.ts`, `web/__tests__/lib/instatusClient.test.ts`, `web/__tests__/api/cron/status-ping.test.ts`.
  - Do: cover ok, slow/degraded, and throwing paths for healthchecks; cover cron happy path, first-failure no-op, second-failure publish, recovery publish, publish-failure logging, missing cron secret, and base URL override.
  - Done when: focused status-page tests pass and the live cron behavior is verified after vendor setup.

---

## wave 3: integration + polish

- [ ] **Task 3.1: footer link**
  - Files: `web/components/Footer.tsx` and landing footer if applicable.
  - Do: add an inline link `system status` pointing at `https://status.owlette.app`. Lowercase. External link.
  - Done when: the link is visible on dashboard and marketing pages after the status page resolves.

- [ ] **Task 3.2: changelog entry**
  - Files: `docs/changelog.md`.
  - Do: add an unreleased entry for the public status page once it is live.
  - Done when: changelog entry and footer link are committed in the same change.

- [ ] **Task 3.3: incident publishing runbook**
  - Files: `dev/active/status-page/reference/runbook.md` (new).
  - Do: cover when to publish, how to publish, standard update templates, when to mark resolved, and postmortem trigger.
  - Done when: the runbook lives in reference docs and is linked from the operator handoff.

- [ ] **Task 3.4: end-to-end test**
  - Files: none; manual test, log results here.
  - Do:
    1. confirm `status.owlette.app` loads and shows 7 green components.
    2. force the API check to fail in a controlled staging environment.
    3. wait 2 ping cycles and confirm the API component flips to degraded.
    4. restore the API check and confirm the component flips back to operational.
    5. publish and resolve a test incident from the Instatus admin UI.
    6. record results inline in this task log.
  - Done when: all 6 steps pass and results are recorded.

---

## log

### 2026-04-28
- Public API W5.1 added the autonomous status-page foundation before vendor setup: healthcheck module, status-ping cron route, Instatus component-status client, focused tests, API docs, and deployment/env docs.
- Tasks remain open because completion still requires user action: Instatus account, `status.owlette.app` DNS/TLS, component ids, Railway cron configuration, and a verified degraded/recovered component flip on the public page.

### 2026-04-26
- Plan created. Vendor: Instatus ($20/mo). Subdomain: `status.owlette.app`. 7 components: dashboard, api, agent registry, webhook delivery, r2 uploads, firestore, cortex chat. Synthetic uptime via Railway cron every 60s. Manual incident publishing. Wave 1 requires user action; waves 2-3 are autonomous after wave 1 lands.
