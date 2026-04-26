# roost k6 load tests

**Wave 5.5.** k6 scripts for the latency-critical roost API endpoints.

## Requirements

- [k6](https://k6.io/docs/getting-started/installation/) installed locally or in CI
- A Firebase ID token with roost-site access (service account, or scripted sign-in)
- A site + roost pre-created on the target environment (`K6_SITE_ID`, `K6_ROOST_ID`)

No npm dependencies — k6 is a standalone binary; these scripts are plain ES modules it executes directly.

## Running

Against the dev environment:

```bash
export K6_BASE_URL=https://dev.owlette.app
export K6_FIREBASE_ID_TOKEN=$(gcloud auth print-identity-token)
export K6_SITE_ID=roost-load-site
export K6_ROOST_ID=roost-load-folder

# smoke (1 VU, 10s) — fast regression check
k6 run --env SCENARIO=smoke load-tests/k6/chunks-check.js

# sustained (ramp 10 → 50 VUs over 5 min)
k6 run --env SCENARIO=sustained load-tests/k6/chunks-check.js

# spike (200 VUs × 30s)
k6 run --env SCENARIO=spike load-tests/k6/chunks-check.js
```

## SLO targets (p99 latency, ms)

| endpoint | p99 ms | rationale |
|---|---|---|
| `POST /api/chunks/check` | **200** | hash-set diff against R2; called once per ~1000-chunk batch |
| `POST /api/chunks/upload-urls` | **500** | R2 signed-URL minting is the slow path; tolerated up to 1000-hash batches |
| `GET /api/chunks/download-urls` | **400** | same shape as upload-urls but reads are cheaper |
| `POST /api/roosts/{id}/manifests` | **800** | firestore transaction + chunk-presence verify + audit append |
| `POST /api/roosts/{id}/rollback` | **400** | pointer flip in a transaction; fast path |
| `GET /api/sites/{s}/deployments` | **250** | Firestore range read (api-sprint wave 1A) |
| `GET /api/sites/{s}/machines/{m}/processes` | **250** | config doc + machine status doc merge (wave 2B) |
| `GET /api/chat?siteId=` | **300** | Firestore composite query w/ siteId filter (wave 3A) |
| `GET /api/users` | **300** | platform users collection scan (wave 3B) |
| `POST /api/sites/{s}/machines/{m}/commands` | **400** | mutation + audit emit (wave 2A) |
| `POST /api/sites/{s}/machines/{m}/processes` | **400** | process-config-lock txn + audit (wave 2B) |

Error-rate gate: `http_req_failed < 0.01` across the run (exception: `race` scenario on `finalize-manifest.js` deliberately produces 412s).

Thresholds are enforced in code (`lib/config.js`); a failing SLO fails the run's exit code. CI can wire the scripts in and treat a non-zero exit as a regression.

## Scripts

### roost (wave 5.5)

- `chunks-check.js` — smoke / sustained / spike scenarios
- `upload-urls.js` — smoke / sustained / burst scenarios
- `finalize-manifest.js` — smoke / sustained / **race** (concurrent-publish CAS regression)

### api-sprint (wave 5.4)

Read-mostly scripts (smoke / sustained / spike — no data side-effects):

- `sites-deployments-list.js` — `GET /api/sites/{siteId}/deployments`
- `process-list.js` — `GET /api/sites/{siteId}/machines/{machineId}/processes`
- `chat-list.js` — `GET /api/chat?siteId=…`
- `users-list.js` — `GET /api/users`

Mutation scripts (smoke + sustained only — see "Mutation cleanup" below):

- `dispatch-machine-command.js` — `POST /api/sites/{siteId}/machines/{machineId}/commands` (reboot type)
- `process-create.js` — `POST /api/sites/{siteId}/machines/{machineId}/processes`

Both mutation scripts use `mutationHeaders(__VU, __ITER)` from `lib/config.js`
to mint a per-VU per-iteration unique `Idempotency-Key` (`k6-<host>-<VU>-<ITER>-<ts>`).
Without this, the 24h idempotency cache would short-circuit every iteration to
the same cached response — the resulting load test would benchmark cache
lookups, not the underlying handler.

### Required env vars (api-sprint scripts)

In addition to `K6_BASE_URL` + auth token (`K6_FIREBASE_ID_TOKEN` or `K6_API_KEY`),
api-sprint scripts read:

- `K6_SITE_ID` — target site id (must exist in the env you're hitting)
- `K6_MACHINE_ID` — target machine id (must exist + be online for command dispatch)

Use `K6_API_KEY` over `K6_FIREBASE_ID_TOKEN` for these — they're public-API
endpoints designed for SDK callers, and the api-key path more closely
mirrors production traffic.

### Mutation cleanup

`dispatch-machine-command.js` and `process-create.js` write real Firestore
documents on every iteration. Recommended hygiene:

1. Use a dedicated load-test machine (`K6_MACHINE_ID=load-test-machine`) so
   the data side-effects don't pollute production fleet state.
2. After each load run, prune the test data:
   ```bash
   # Clear queued commands
   gcloud firestore documents delete \
     "sites/${K6_SITE_ID}/machines/${K6_MACHINE_ID}/commands/pending"

   # Clear test processes — easiest is to overwrite the machine doc's
   # `processes` array with an empty list via the admin script.
   ```
3. (Optional) Add a periodic GitHub Action that resets the load-test site +
   machine docs nightly.

## The `race` scenario

`finalize-manifest.js --env SCENARIO=race` fires 20 VUs at the same roost, each with the same `expectedCurrentManifestId` pointer. If the compare-and-swap in the finalize transaction is correct, **exactly one** gets 201; the rest see 412 PreconditionFailed. If more than one 201 lands, the CAS is broken — that's a P0 regression this scenario guards against.

Inspect the response-status distribution after the run; k6's default summary bundles by status code.

## Wiring into CI

When wave 0.6 (GCP deploy) is live, a github-actions job should run the `smoke` scenario on every PR that touches `/api/chunks/*` or `/api/roosts/*`, and the `sustained` scenarios nightly against dev. The deploy pipeline for prod should gate on a green sustained run.

## Results location

Numbers from real runs land in `dev/active/project-distribution-v2/load-test-report.md`. That file is structured so CI can append new runs over time.
