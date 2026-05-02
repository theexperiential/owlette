# API load testing and SLOs

**Last updated**: 2026-04-29

External public launch requires a load-test pass against the public API hot paths. The k6 suite lives in `load-tests/k6` and enforces p99 latency plus a base reliability budget.

Developer preview can proceed without these runs. External launch should not.

---

## launch gate

5.2 is externally complete when:

- the launch fixture site, machine, and roost exist in dev or staging
- `K6_API_KEY`, `K6_SITE_ID`, `K6_MACHINE_ID`, `K6_ROOST_ID`, and `K6_VERSION_CHUNK_HASHES` are configured for the fixture
- every read-only script passes `smoke` and `sustained`
- read-heavy scripts pass `spike`, and signed-URL scripts pass `burst`, or have a recorded launch waiver
- mutation scripts pass `smoke` and `sustained` against disposable data
- the final report records p95, p99, error rate, runner, base URL, and any waivers

The gate is about customer-facing launch confidence, not local unit-test coverage.

---

## targets

The authoritative p99 thresholds are enforced in `load-tests/k6/lib/config.js`.

| script | endpoint | p99 target | launch role |
|---|---|---:|---|
| `sites-list.js` | `GET /api/sites` | 300 ms | account inventory bootstrap |
| `machines-list.js` | `GET /api/sites/{siteId}/machines` | 500 ms | fleet inventory bootstrap |
| `sites-deployments-list.js` | `GET /api/sites/{siteId}/deployments` | 250 ms | deployment history polling |
| `process-list.js` | `GET /api/sites/{siteId}/machines/{machineId}/processes` | 250 ms | process monitoring and CLI reads |
| `cortex-conversations-list.js` | `GET /api/cortex/conversations` | 300 ms | Cortex conversation list |
| `users-list.js` | `GET /api/users` | 300 ms | platform admin list |
| `dispatch-machine-command.js` | `POST /api/sites/{siteId}/machines/{machineId}/commands` | 400 ms | async machine command queue |
| `process-create.js` | `POST /api/sites/{siteId}/machines/{machineId}/processes` | 400 ms | process config mutation |
| `chunks-check.js` | `POST /api/chunks/check` | 200 ms | roost upload diff |
| `upload-urls.js` | `POST /api/chunks/upload-urls` | 500 ms | R2 signed URL issuance |
| `download-urls.js` | `GET /api/chunks/download-urls` | 400 ms | roost chunk download URL issuance |
| `publish-version.js` | `POST /api/roosts/{roostId}/versions` | 800 ms | roost publish transaction |

Base reliability budget: `http_req_failed < 0.01`.

k6 summaries report `avg`, `p(95)`, `p(99)`, and `max`. Launch reports must record p95 and p99 even though p99 is the hard gate.

---

## scenarios

| scenario | shape | required for |
|---|---|---|
| `smoke` | 1 VU for 10 seconds | every script before merge or launch handoff |
| `sustained` | normal launch load ramp | every script before external launch |
| `spike` | 200 VUs for 30 seconds | read-heavy scripts |
| `burst` | signed-URL burst | `upload-urls.js`, `download-urls.js` |
| `race` | 20 concurrent publish attempts | `publish-version.js` compare-and-swap guard |

The `race` scenario deliberately produces 412 responses. Set `K6_EXPECTED_CURRENT_VERSION_ID` to the roost head immediately before the run. The script thresholds require exactly one 201 winner and nineteen 412 losers; anything else is a P0 compare-and-swap regression.

---

## running

```powershell
$env:K6_BASE_URL = 'https://dev.owlette.app'
$env:K6_API_KEY = 'owk_test_...'
$env:K6_SITE_ID = 'owlette-load-site'
$env:K6_MACHINE_ID = 'owlette-load-machine'
$env:K6_ROOST_ID = 'roost-load-folder'
$env:K6_VERSION_CHUNK_HASHES = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

k6 run --env SCENARIO=smoke load-tests/k6/sites-list.js
k6 run --env SCENARIO=sustained load-tests/k6/sites-list.js
```

Prefer API keys over Firebase ID tokens for launch SLO runs because external clients use the API-key path.

---

## report template

Append one entry per final launch run:

```text
### YYYY-MM-DD - dev - sustained

- base URL: https://dev.owlette.app
- script: sites-list.js
- scenario: sustained
- result: PASS / FAIL
- p95 observed: ___ ms
- p99 observed: ___ ms
- error rate: ___ %
- runner: local / github-actions / other
- fixture: site=<id>, machine=<id>, roost=<id>
- notes: cold starts, rate-limit hits, fixture size, waivers, or cleanup needed
```

---

## current status

Scripts and SLO thresholds are in place. Real p95/p99 numbers are pending a dev or staging fixture key and k6 runner. Until those numbers are recorded, 5.2 remains launch-blocked but not developer-preview-blocked.
