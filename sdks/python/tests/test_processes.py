"""Tests for ``roost.processes`` (wave 2B)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_factory_returns_bound_handle() -> None:
    async with Roost(token="owk_live_x", transport=_transport(lambda _r: httpx.Response(200, json={}))) as client:
        h = client.processes("s1", "m1")
        assert h.site_id == "s1"
        assert h.machine_id == "m1"


@pytest.mark.asyncio
async def test_list_unwraps_data_envelope_and_parses_records() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "processes": [
                        {
                            "processId": "p1",
                            "name": "td",
                            "exe_path": "C:/x/td.exe",
                            "cwd": "C:/x",
                            "priority": "Normal",
                            "visibility": "Show",
                            "launch_mode": "always",
                            "autolaunch": True,
                            "status": "running",
                            "pid": 4242,
                            "responsive": True,
                            "schedule": None,
                            "schedules": None,
                            "last_updated": "2026-04-25",
                        }
                    ],
                    "nextPageToken": None,
                },
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        rows = await client.processes("s1", "m1").list()

    assert captured[0].url.path == "/api/sites/s1/machines/m1/processes"
    assert len(rows) == 1
    assert rows[0].process_id == "p1"
    assert rows[0].pid == 4242


@pytest.mark.asyncio
async def test_create_emits_idempotency_key_and_serialises_optional_fields() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"ok": True, "data": {"processId": "p2"}})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.processes("s1", "m1").create(
            name="td",
            exe_path="C:/x/td.exe",
            cwd="C:/x",
            launch_mode="always",
        )

    assert out == {"processId": "p2"}
    req = captured[0]
    assert req.method == "POST"
    body = json.loads(req.content)
    assert body == {
        "name": "td",
        "exe_path": "C:/x/td.exe",
        "cwd": "C:/x",
        "launch_mode": "always",
    }
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_control_verbs_and_schedule_dispatch_correct_paths() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"ok": True, "data": {"commandId": "cmd_1", "status": "queued"}})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        h = client.processes("s1", "m1")
        await h.kill("p1")
        await h.start("p1")
        await h.stop("p1")
        await h.schedule(
            "p1",
            mode="scheduled",
            blocks=[{"day": "mon", "start": "09:00", "end": "17:00"}],
        )

    paths = [str(c.url.path) for c in captured]
    assert paths == [
        "/api/sites/s1/machines/m1/processes/p1/kill",
        "/api/sites/s1/machines/m1/processes/p1/start",
        "/api/sites/s1/machines/m1/processes/p1/stop",
        "/api/sites/s1/machines/m1/processes/p1/schedule",
    ]
    schedule_body = json.loads(captured[3].content)
    assert schedule_body["mode"] == "scheduled"
    assert schedule_body["blocks"][0]["day"] == "mon"


@pytest.mark.asyncio
async def test_schedule_requires_blocks_when_mode_scheduled() -> None:
    async with Roost(
        token="owk_live_x",
        transport=_transport(lambda _r: httpx.Response(200, json={})),
    ) as client:
        with pytest.raises(ValueError, match="blocks"):
            await client.processes("s1", "m1").schedule("p1", mode="scheduled")


@pytest.mark.asyncio
async def test_update_requires_at_least_one_field() -> None:
    async with Roost(
        token="owk_live_x",
        transport=_transport(lambda _r: httpx.Response(200, json={})),
    ) as client:
        with pytest.raises(ValueError, match="at least one field"):
            await client.processes("s1", "m1").update("p1")


@pytest.mark.asyncio
async def test_duplicate_process_name_surfaces_typed_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"code": "duplicate_process_name", "detail": "name 'td' taken"},
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.processes("s1", "m1").create(name="td", exe_path="x.exe")
        assert excinfo.value.code == "duplicate_process_name"
