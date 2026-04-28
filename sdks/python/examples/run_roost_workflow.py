"""Minimal public API workflow for the Python SDK.

Required:
    OWLETTE_TOKEN or ROOST_TOKEN
    OWLETTE_SITE_ID or ROOST_SITE_ID
    OWLETTE_ROOST_ID or ROOST_ID

Optional:
    OWLETTE_API_URL or ROOST_BASE      default: https://owlette.app
    BUILD_DIR                         default: ./dist
    OWLETTE_DEPLOY=1 or ROOST_DEPLOY=1
"""

from __future__ import annotations

import asyncio
import os
import sys

from roost import DeployOptions, PushOptions, Roost, RoostApiError


def _env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _progress(evt: object) -> None:
    phase = getattr(evt, "phase", "")
    if phase == "upload":
        print(f"upload {evt.uploaded}/{evt.total}")  # type: ignore[attr-defined]
    elif phase == "publish":
        print(f"publish attempt {evt.attempt}")  # type: ignore[attr-defined]


async def main() -> int:
    token = _env("OWLETTE_TOKEN", "ROOST_TOKEN")
    site_id = _env("OWLETTE_SITE_ID", "ROOST_SITE_ID")
    roost_id = _env("OWLETTE_ROOST_ID", "ROOST_ID")
    api_url = _env("OWLETTE_API_URL", "ROOST_BASE") or "https://owlette.app"
    build_dir = os.environ.get("BUILD_DIR", "./dist")
    deploy_enabled = _env("OWLETTE_DEPLOY", "ROOST_DEPLOY") == "1"

    missing = [
        name
        for name, value in (
            ("OWLETTE_TOKEN or ROOST_TOKEN", token),
            ("OWLETTE_SITE_ID or ROOST_SITE_ID", site_id),
            ("OWLETTE_ROOST_ID or ROOST_ID", roost_id),
        )
        if not value
    ]
    if missing:
        print("missing env: " + ", ".join(missing), file=sys.stderr)
        return 1

    assert token and site_id and roost_id

    async with Roost(token=token, api_url=api_url) as client:
        try:
            identity = await client.account.whoami()
            version = await client.account.version()
            print("identity", identity.email or identity.user_id or "api-key")
            print("api version", version.current)

            site = await client.sites.get(site_id)
            roost = await client.roosts.get(roost_id, site_id=site_id)
            print("site", site.id, site.name)
            print("roost", roost.roost_id, roost.name)

            result = await client.roosts.push(
                build_dir,
                roost_id,
                PushOptions(site_id=site_id, on_progress=_progress),
            )
            print(f"published v{result.version_number} {result.version_id}")

            if deploy_enabled:
                rollout = await client.roosts.deploy(
                    roost_id,
                    DeployOptions(site_id=site_id, version_id=result.version_id),
                )
                print("rollout", rollout.rollout_id, rollout.stage)

            return 0
        except RoostApiError as err:
            detail = err.problem.get("detail")
            print(f"api error {err.status} {err.code}: {detail}", file=sys.stderr)
            if err.request_id:
                print(f"request_id: {err.request_id}", file=sys.stderr)
            return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
