# syntax=docker/dockerfile:1.6

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_DATA_HOME=/tmp/owlette-data

WORKDIR /app

# The compose service builds with context ./agent-runner and a named repo
# context so the Dockerfile can copy only the files it needs from the repo
# root without sending agent/build or the rest of the monorepo as the primary
# build context.
COPY --from=repo agent/requirements.txt /tmp/agent-requirements.txt
COPY requirements.txt /tmp/agent-runner-requirements.txt

RUN python - <<'PY' > /tmp/agent-requirements-linux.txt
from pathlib import Path

skip_packages = {"pywin32"}

for raw in Path("/tmp/agent-requirements.txt").read_text().splitlines():
    stripped = raw.strip()
    if not stripped or stripped.startswith("#"):
        print(raw)
        continue
    package = stripped.split("#", 1)[0].strip().split("==", 1)[0].split(">=", 1)[0].split("<", 1)[0].strip()
    if package.lower() in skip_packages:
        print(f"# skipped on Linux agent-runner: {raw}")
        continue
    print(raw)
PY

RUN pip install --no-cache-dir --disable-pip-version-check \
        -r /tmp/agent-requirements-linux.txt \
        -r /tmp/agent-runner-requirements.txt

COPY --from=repo agent/src/ /app/agent/src/
COPY --from=repo agent/tests/ /app/agent/tests/
COPY --from=repo agent/VERSION /app/agent/VERSION
COPY pywin32-stubs/ /app/stubs/
COPY tests/ /app/test/infra/agent-runner/tests/

ENV PYTHONPATH=/app/stubs:/app/agent/src:/app

CMD ["python", "-m", "pytest", "agent/tests/unit/test_sync_state.py", "agent/tests/unit/test_sync_version.py", "agent/tests/unit/test_sync_downloader.py", "agent/tests/unit/test_sync_assembler.py", "agent/tests/unit/test_sync_commands.py", "test/infra/agent-runner/tests/test_sync_pipeline_minio.py", "-v"]
