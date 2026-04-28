"""Machine command polling workflow.

Safe default: poll an existing command when OWLETTE_COMMAND_ID is set.
To dispatch a new command, set OWLETTE_DISPATCH_COMMAND=1 explicitly.

Required env:
    OWLETTE_TOKEN or ROOST_TOKEN
    OWLETTE_SITE_ID or ROOST_SITE_ID
    OWLETTE_MACHINE_ID or ROOST_MACHINE_ID

Optional:
    OWLETTE_API_URL or ROOST_BASE defaults to https://owlette.app
    OWLETTE_COMMAND_ID polls an existing command instead of dispatching
    OWLETTE_COMMAND_TYPE defaults to capture_screenshot
    OWLETTE_MONITOR defaults to primary for capture_screenshot
    OWLETTE_POLL_SECONDS defaults to 1.5
    OWLETTE_TIMEOUT_SECONDS defaults to 60
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
from typing import cast

from roost import CommandType, Roost, RoostApiError

ALLOWED_COMMAND_TYPES = {"capture_screenshot", "reboot_machine", "shutdown_machine"}


def _env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _float_env(name: str, default: float) -> float | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return None


async def main() -> int:
    token = _env("OWLETTE_TOKEN", "ROOST_TOKEN")
    api_url = _env("OWLETTE_API_URL", "ROOST_BASE") or "https://owlette.app"
    site_id = _env("OWLETTE_SITE_ID", "ROOST_SITE_ID")
    machine_id = _env("OWLETTE_MACHINE_ID", "ROOST_MACHINE_ID")
    command_id = _env("OWLETTE_COMMAND_ID", "ROOST_COMMAND_ID")
    raw_command_type = os.environ.get("OWLETTE_COMMAND_TYPE", "capture_screenshot")
    should_dispatch = os.environ.get("OWLETTE_DISPATCH_COMMAND") == "1"
    poll_seconds = _float_env("OWLETTE_POLL_SECONDS", 1.5)
    timeout_seconds = _float_env("OWLETTE_TIMEOUT_SECONDS", 60.0)

    missing = [
        name
        for name, value in (
            ("OWLETTE_TOKEN or ROOST_TOKEN", token),
            ("OWLETTE_SITE_ID or ROOST_SITE_ID", site_id),
            ("OWLETTE_MACHINE_ID or ROOST_MACHINE_ID", machine_id),
        )
        if not value
    ]
    if missing:
        print("missing env var: " + ", ".join(missing), file=sys.stderr)
        return 1
    if raw_command_type not in ALLOWED_COMMAND_TYPES:
        print(f"unsupported OWLETTE_COMMAND_TYPE: {raw_command_type}", file=sys.stderr)
        return 1
    if command_id is None and not should_dispatch:
        print(
            "set OWLETTE_COMMAND_ID to poll, or OWLETTE_DISPATCH_COMMAND=1 to dispatch",
            file=sys.stderr,
        )
        return 1
    if (
        poll_seconds is None
        or timeout_seconds is None
        or not math.isfinite(poll_seconds)
        or poll_seconds <= 0
        or not math.isfinite(timeout_seconds)
    ):
        print(
            "OWLETTE_POLL_SECONDS must be > 0 and "
            "OWLETTE_TIMEOUT_SECONDS must be numeric",
            file=sys.stderr,
        )
        return 1

    assert token and site_id and machine_id
    command_type = cast(CommandType, raw_command_type)

    async with Roost(token=token, api_url=api_url) as client:
        try:
            if command_id is None:
                params: dict[str, object] = {}
                if command_type == "capture_screenshot":
                    params["monitor"] = os.environ.get("OWLETTE_MONITOR", "primary")
                queued = await client.machines.dispatch_command(
                    site_id,
                    machine_id,
                    command_type,
                    params,
                )
                command_id = str(queued["commandId"])
                print("queued", command_id, queued.get("status"))

            max_polls = max(1, math.ceil(timeout_seconds / poll_seconds))
            for _attempt in range(max_polls):
                status = await client.machines.get_command(site_id, machine_id, command_id)
                state = str(status.get("status", ""))
                print("status", command_id, state)
                if state == "completed":
                    print(json.dumps(status.get("result") or {}, indent=2))
                    return 0
                if state == "failed":
                    print(str(status.get("error") or "command failed"), file=sys.stderr)
                    return 2
                await asyncio.sleep(poll_seconds)

            print(f"timed out waiting for {command_id}", file=sys.stderr)
            return 3
        except RoostApiError as err:
            detail = err.problem.get("detail")
            print(f"api error {err.status} {err.code}: {detail}", file=sys.stderr)
            if err.request_id:
                print(f"request_id: {err.request_id}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
