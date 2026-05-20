# roost test infrastructure

**Wave 1.6 (piecemeal).** Local + CI stand-ins for the Cloudflare R2 production dependencies. Lets the wave-2a routes (`/api/chunks/*`, `/api/roosts/*/manifests`) get wired against real S3-compatible storage without waiting on Cloudflare R2 procurement or service-account keys.

## MinIO — local R2 stand-in

```bash
docker compose -f test/infra/docker-compose.yml up -d

# init-buckets exits once setup is done; wait for it (<10 s):
docker compose -f test/infra/docker-compose.yml logs init-buckets
```

After that:

- **S3 API**: `http://localhost:9000` — point web API clients here in dev/test
- **Admin console**: `http://localhost:9001` (login `minioadmin` / `minioadmin` — dev-only)
- **Buckets**: `owlette-dev-content`, `owlette-dev-manifests` created + set to default-deny (anonymous requests → 403)

### Wiring the web API

When wave 2a.1–2a.6 wire up real handlers, point the S3 client at MinIO via env var:

```bash
# web/.env.local for local dev (or CI env for emulator runs)
OWLETTE_R2_ENDPOINT=http://localhost:9000
OWLETTE_R2_ACCESS_KEY_ID=minioadmin
OWLETTE_R2_SECRET_ACCESS_KEY=minioadmin
OWLETTE_R2_BUCKET_CONTENT=owlette-dev-content
OWLETTE_R2_BUCKET_MANIFESTS=owlette-dev-manifests
OWLETTE_R2_REGION=auto    # R2 uses "auto"; MinIO accepts anything
```

The `@aws-sdk/client-s3` library speaks both R2 and MinIO unchanged — no code changes needed to swap between them.

### Bucket policy parity

The init script applies **default-deny anonymous access** via `mc anonymous set none`, mirroring the R2 `DenyAnonymousAccess` statement in `storage/r2-bucket-policy.json`. The full R2 policy JSON isn't directly applicable — MinIO uses an AWS IAM subset — but the functional surface (anonymous → 403, signed → allowed) matches.

The script also does a smoke-check that anonymous listing returns 403 and exits non-zero if not.

## Teardown

```bash
# stop containers, keep data
docker compose -f test/infra/docker-compose.yml down

# stop + wipe uploaded chunks
docker compose -f test/infra/docker-compose.yml down -v
```

## What's here vs what isn't

| wave-1.6 target | status | location |
|---|---|---|
| firebase emulator wired into test setup | partial (phase A in commit `cb8d06e`) | `web/e2e/` |
| MinIO / S3-compatible for R2 mocking | **here** | `test/infra/` |
| k6 load-test scaffold | done (wave 5.5) | `test/load/k6/` |
| containerised agent runner for e2e | not started | — |
| pact contract test scaffold | not started | — |

The containerised agent runner + pact are the remaining blockers for wave 4c.5 (e2e agent test in CI).

## CI integration (future)

The docker-compose file is CI-friendly — GitHub Actions' `docker compose` action runs it unchanged. Add a job step:

```yaml
- name: start test infra
  run: |
    docker compose -f test/infra/docker-compose.yml up -d
    docker compose -f test/infra/docker-compose.yml run --rm init-buckets
- name: web tests against minio
  env:
    OWLETTE_R2_ENDPOINT: http://localhost:9000
    OWLETTE_R2_ACCESS_KEY_ID: minioadmin
    OWLETTE_R2_SECRET_ACCESS_KEY: minioadmin
  run: cd web && npm test
```

Wiring this into existing workflows is deferred until 2a routes are real — running this setup for a test suite that doesn't actually touch MinIO is burning runner minutes for nothing.
