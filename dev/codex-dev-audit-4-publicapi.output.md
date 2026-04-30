# Public API plan-vs-code audit

## Summary
- 10/32 checked boxes spot-checked and verified.
- 5 wave-5 items broken down by dev/launch.
- 1 endpoint-surface audit gap: `dev/active/public-api/reference/endpoint-surface.md` is missing. OpenAPI route sync itself has 0 public route gaps.
- OpenAPI validator result: `npm.cmd run validate:api` passed, validating 106 documented paths against 144 route files and 153 rendered operations.
- Main development left before GA is not core route implementation. It is SDK/CLI coverage/release automation, launch docs/site polish, and any decision to replace placeholder status telemetry.

## Wave 5 breakdown

### 5.1 status page
- DEV portion: The repo already has the status-page foundation: `web/lib/healthChecks.server.ts`, `web/lib/instatusClient.ts`, `web/app/api/cron/status-ping/route.ts`, focused tests under `web/__tests__/api/cron/status-ping.test.ts` and `web/__tests__/lib/instatusClient.test.ts`, plus docs in `docs/api/status-uptime.md`, `docs/setup/environment-variables.md`, and `docs/setup/web-deployment.md`. Remaining code is optional unless launch requires real telemetry for the placeholder `r2_uploads` and `cortex_chat` components instead of the documented placeholder health. Effort: S, or M if real R2/Cortex telemetry must be built before GA.
- LAUNCH portion: Create the Instatus hosted page, create seven components, record `INSTATUS_*` page/component ids, configure the 60-second cron, verify degraded/recovered flips, and publish/resolve a test incident. `status.owlette.app` is explicitly deferred.

### 5.2 load testing
- DEV portion: k6 source exists in `load-tests/k6/` with hot-path scripts and thresholds in `load-tests/k6/lib/config.js`; docs are in `docs/api/load-testing.md`. Remaining dev is only report/template upkeep or route optimization if measured runs fail. Effort: S known work, unknown if perf fixes are discovered.
- LAUNCH portion: Install/run k6, provision dev/staging fixture values (`K6_API_KEY`, site, machine, Roost, chunk hashes), run smoke/sustained/spike/burst/race scenarios, and record real p95/p99/error-rate numbers.

### 5.3 SDK publishing
- DEV portion: RC package metadata exists for `cli/package.json`, `sdks/node/package.json`, and `sdks/python/pyproject.toml`; license files and docs exist. Code/config still left: Node SDK and Python SDK publish automation are not present; package scripts have build/test/lint but no publish scripts. `.github/workflows/cli-publish.yml` exists, but it is stable-tag oriented (`cli-vX.Y.Z`) and its publish command does not use `--tag rc`, so it is not fully wired for `1.0.0-rc.0`. Homebrew/Scoop/winget manifests are not present in this repo. If GA requires high-level SDK/CLI helpers for every OpenAPI operation, that is a larger SDK/CLI dev gap. Effort: M for release automation/manifests; L if full high-level endpoint coverage is required.
- LAUNCH portion: Registry owner/MFA approval, actual npm/PyPI publishes, TestPyPI/PyPI verification, clean-machine install smokes, and Homebrew/Scoop/winget publication or explicit waivers.

### 5.4 launch site
- DEV portion: MkDocs launch docs and examples exist: `docs/api/launch-assets.md`, `docs/api/examples/*.md`, `sdks/node/examples/*.ts`, `sdks/python/examples/*.py`, `.github/actions/owlette-roost-deploy/`, and `examples/github-actions/roost-deploy.yml`. Remaining code/content is final public landing/pricing/signup/download linkage in `web/app/`, plus narrative docs for public route families that currently rely mostly on OpenAPI/reference pages. Effort: M.
- LAUNCH portion: Deploy final public site/docs, settle pricing/signup copy, publish marketplace/listing text for npm/PyPI/GitHub Action, and either create external example repos or waive them in favor of in-repo templates.

### 5.5 launch flag/runbook
- DEV portion: I found security-boundary kill-switch docs/config (`docs/ops/security-boundary-*.md`, `monitoring/security-boundary-alerts.yaml`, `web/app/api/platform/security/kill-switch/route.ts`), but no public-api-specific launch flag or first-week public API runbook. If "launch flag" means a real gate in app behavior, that needs design and implementation. If launch is purely distribution/docs/status, the dev work is a concise support/runbook doc plus first-week monitoring checklist wired to existing Sentry/security/status/load-test assets. Effort: S/M depending on whether a real runtime flag is required.
- LAUNCH portion: Assign support ownership, define rollback criteria, wire alert recipients/dashboards, run the first-week monitoring cadence, and execute the intentional external launch flip.

## Spot-check discrepancies
- No discrepancies found in the 10 randomly sampled completed tasks.
- [0.4] Verified `dev/active/public-api/reference/public-api-contract.md` and `web/lib/apiKeyTypes.ts` define version/scope vocabulary.
- [1.1] Verified `web/openapi.yaml`, `web/scripts/validate-openapi.ts`, and successful `npm.cmd run validate:api`.
- [1.2] Verified `web/lib/apiErrors.ts`, `web/lib/apiErrorResponse.ts`, and tests under `web/__tests__/lib/`.
- [1.3] Verified `web/lib/idempotency.ts`, `web/__tests__/api/idempotency.test.ts`, and OpenAPI `Idempotency-Key` usage.
- [1.4] Verified `web/lib/pagination.ts`, `web/__tests__/lib/pagination.test.ts`, and docs in `docs/api/pagination.md`.
- [2.5] Verified display-layout route, OpenAPI coverage, tests, and `reference/wave-2.5-displays-closure.md`.
- [2.8] Verified logs and audit-log routes/tests: `web/app/api/sites/[siteId]/logs/**`, `web/app/api/sites/[siteId]/audit-log/**`, `web/__tests__/api/site-logs.test.ts`, and `web/__tests__/api/site-audit-log.test.ts`.
- [2.9] Verified Cortex routes/docs/tests: `web/app/api/cortex/conversations/**`, compatibility `web/app/api/chat/**`, `docs/api/cortex.md`, `web/__tests__/api/chat.test.ts`.
- [3.3] Verified Node SDK source, examples, and tests under `sdks/node/src`, `sdks/node/examples`, and `sdks/node/__tests__`.
- [4.1] Verified OpenAPI reference render path: `web/app/api/openapi/route.ts`, `web/lib/openapiReference.ts`, `docs/api/reference.md`; validator reports rendered examples/auth-scope notes for all 153 operations.

## Endpoint surface gaps
- `dev/active/public-api/reference/endpoint-surface.md` does not exist. A legacy Roost-only file exists under `dev/active/public-api/reference/legacy-roost-public-api/endpoint-surface.md`, but it is not the locked active contract named by this audit.
- Spec endpoint with no implementation: cannot be evaluated against the missing endpoint-surface contract. Against `web/openapi.yaml`, validator found none.
- Implementation not in spec: validator found no undocumented public routes. It intentionally allowlists internal/agent/cron/settings routes; total route files exceed documented paths because 144 route files include internal surfaces.
- OpenAPI validator command requested by mission: `npx.cmd --no-install ts-node web/scripts/validate-openapi.ts` did not work because `ts-node` is not installed locally and npm attempted a registry fetch. Repo validator used instead:

```text
Validating 106 documented paths against 144 route files...

All documented paths match route files. No undocumented public routes found.
Rendered API reference includes examples and auth/scope notes for 153 operations.
```

## SDK + CLI status
- Node SDK: about 87/153 OpenAPI method+path operations have high-level wrappers in `sdks/node/src` after correcting the source scan for same-path GET/PATCH methods. Raw escape hatch `roost.http.request(...)` can call the rest, but high-level coverage is not complete. Tests: `sdks/node/__tests__/client.test.ts`, `resources.test.ts`, `smoke.test.ts`. Publish script: no package-local publish script; no Node SDK publish workflow found.
- Python SDK: about 84/153 OpenAPI method+path operations have high-level wrappers in `sdks/python/roost`. Raw `client.http.request(...)` escape hatch exists, but high-level coverage is not complete. Tests exist under `sdks/python/tests`. Publish script: no package-local publish script or workflow; `pyproject.toml` has build metadata only.
- CLI: about 63/153 OpenAPI method+path operations are reachable through `owlette` commands. Tests exist under `cli/__tests__`. Publish script: no package-local publish script; `.github/workflows/cli-publish.yml` exists but is not RC-ready as written.
- Common high-level coverage gaps: platform utilities, agent-token/admin status surfaces, logs/audit-log in SDKs, site CRUD mutations, presets/project distributions, several machine controls, display-layout/reboot/cortex-enabled/uninstall, compatibility `/api/chat/*`, and public narrative wrappers/docs for many non-Roost families.

## Doc site / examples
- Docs site source is MkDocs Material, not Mintlify/Nextra/Docusaurus. Source is `docs/`; nav/config is `mkdocs.yml`; deployment workflow is `.github/workflows/deploy-docs.yml`.
- Existing public API docs include overview, reference, quickstart, auth, pagination, idempotency, errors, rate limits, chunks, versions, cortex, webhooks, SDK pages, distribution, status, load testing, launch assets, and examples.
- Missing narrative docs pages if GA means "developer can understand every public route without reading OpenAPI": sites, machines, processes, classic deployments, installer management, users/members, quotas, logs, audit-log, presets/project distributions, platform utilities, and first-week support/runbook material.

## Top 3 DEV items left before public-api can GA
1. Decide and close the SDK/CLI high-level coverage gap: either add wrappers/commands for the remaining public OpenAPI operations or explicitly document that non-MVP endpoints are raw-client/OpenAPI-only for GA.
2. Fix distribution automation: add RC-aware publish workflows/scripts for `@owlette/sdk`, `owlette-sdk`, and `@owlette/cli`, plus Homebrew/Scoop/winget manifests or written launch waivers.
3. Finish launch-support code/docs: public API launch runbook, first-week monitoring checklist, final launch-site/docs pages, and optionally real R2/Cortex status telemetry instead of placeholders.
