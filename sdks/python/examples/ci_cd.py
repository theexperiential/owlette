"""ci/cd: publish a new roost version on every git tag.

Mirrors docs/api/examples/ci-cd-github-actions.md but replaces ~150 lines
of curl + jq with a single ``client.roosts.push()`` call. Drop it into a
GitHub Actions step that runs ``python ci_cd.py``.

Required env vars:
    ROOST_TOKEN     — api key with roost:<id>:write,deploy scope
    ROOST_SITE_ID   — site hosting the roost
    ROOST_ID        — target roost id
    BUILD_DIR       — directory to publish (defaults to ./build)

Exits 0 on success, 1 on recoverable failure, 2 on scope/quota errors.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import sys

from roost import DeployOptions, PushOptions, Roost, RoostApiError


async def main() -> int:
    token = os.environ.get("ROOST_TOKEN")
    site_id = os.environ.get("ROOST_SITE_ID")
    roost_id = os.environ.get("ROOST_ID")
    build_dir = os.environ.get("BUILD_DIR", "./build")
    api_url = os.environ.get("ROOST_BASE", "https://owlette.app")
    version = os.environ.get("GITHUB_REF_NAME", "dev")

    for name, val in [("ROOST_TOKEN", token), ("ROOST_SITE_ID", site_id), ("ROOST_ID", roost_id)]:
        if not val:
            print(f"fatal: missing env var {name}", file=sys.stderr)
            return 1

    assert token and site_id and roost_id  # narrowing for mypy

    def on_progress(evt: object) -> None:
        phase = getattr(evt, "phase", None)
        if phase == "upload":
            print(f"  upload {evt.uploaded}/{evt.total}")  # type: ignore[attr-defined]
        elif phase == "publish":
            print(f"  publish attempt {evt.attempt}")  # type: ignore[attr-defined]

    async with Roost(token=token, api_url=api_url) as client:
        try:
            print(f"[ci-cd] publishing {build_dir} → {roost_id} (version {version})")
            result = await client.roosts.push(
                build_dir, roost_id,
                PushOptions(site_id=site_id, on_progress=on_progress),
            )
            print(f"[ci-cd] published version v{result.version_number} ({result.version_id})")
            print(f"[ci-cd] stats: {json.dumps(dataclasses.asdict(result.stats), default=str)}")

            deploy = await client.roosts.deploy(roost_id, DeployOptions(site_id=site_id))
            print(f"[ci-cd] rollout {deploy.rollout_id} — {len(deploy.fleet)} machines queued")
            return 0
        except RoostApiError as err:
            print(f"[ci-cd] roost api error {err.status} {err.code}: {err.problem.get('detail')}", file=sys.stderr)
            print(f"  request_id: {err.request_id}", file=sys.stderr)
            if err.code in ("scope_insufficient", "quota_exceeded"):
                return 2
            return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
