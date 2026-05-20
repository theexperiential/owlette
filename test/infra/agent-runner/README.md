# Containerised agent runner

This runner builds a Python 3.11 Linux container that imports and tests the
roost agent sync modules without a Windows host. It copies the existing agent
source and tests, prepends lightweight Windows API stubs to `PYTHONPATH`, and
runs pytest against the sync unit modules.

The runner is intentionally scoped to the sync engine:

- `sync_state.py`
- `sync_version.py`
- `sync_downloader.py`
- `sync_assembler.py`
- `sync_commands.py` for the `sync_pull` command handler

`owlette_service.py` is not an entrypoint target. It is the Windows service
host and imports real pywin32 service APIs at module load.

## Build and run

From the repository root:

```bash
docker compose -f test/infra/docker-compose.yml up --build agent-runner
```

This uses Docker Compose v2/BuildKit named build contexts so the runner can
build from `test/infra/agent-runner/` while copying only `agent/src`,
`agent/tests`, `agent/VERSION`, and `agent/requirements.txt` from the repo root.

The same command also starts the MinIO R2 stand-in and waits for the bucket
initialiser before running pytest. The agent container sees MinIO at:

```text
http://minio:9000
```

The current smoke output is captured at:

```text
test/infra/agent-runner/smoke-output.log
```

## Adding test modules

The default test command lives in `test/infra/agent-runner/Dockerfile` as the
`CMD` array. Add new modules in dependency order so failures are easy to
attribute. The recommended order is:

```text
agent/tests/unit/test_sync_state.py
agent/tests/unit/test_sync_version.py
agent/tests/unit/test_sync_downloader.py
agent/tests/unit/test_sync_assembler.py
agent/tests/unit/test_sync_commands.py
test/infra/agent-runner/tests/test_sync_pipeline_minio.py
```

After adding a module, rebuild and run:

```bash
docker compose -f test/infra/docker-compose.yml up --build agent-runner
```

## Known limitations

- The repo does not currently contain `agent/src/sync_pull.py`; `sync_pull` is
  implemented as `_handle_sync_pull` in `agent/src/sync_commands.py`.
- The pywin32 stubs are import shims, not Windows emulators. Runtime calls to
  service control, registry enumeration, window management, ACL editing, or
  session APIs either no-op for harmless lock paths or raise clearly.
- `firebase_client.py` is not imported by the entrypoint. It imports
  `display_manager.py`, which binds Windows CCD APIs and assumes Windows ABI
  ctypes structure sizes at module load. Fake-service tests should call
  `sync_commands` directly and provide in-memory Firestore/R2 URL providers.
- `test_sync_pipeline_minio.py` uses MinIO for manifest/chunk HTTP fetches and
  mocks Firestore at the Python level. The existing sync modules do not need a
  live Firestore emulator until the CI suite tests web-issued commands or
  `firebase_client` reporting directly.
- No production agent code is changed by this runner.

## CI consumption

Wave 4c.5 can use this service in GitHub Actions by checking out the repo,
starting the compose stack, and letting the runner entrypoint decide pass/fail:

```bash
docker compose -f test/infra/docker-compose.yml up --build --exit-code-from agent-runner agent-runner
```

That command returns pytest's exit code, so CI fails if the container cannot
import the sync modules or if the selected sync tests fail.
