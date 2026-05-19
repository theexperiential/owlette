"""Tests for ``roost.members`` (wave 3B)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_factory_binds_site_id() -> None:
    async with Roost(
        token="owk_live_x",
        transport=_transport(lambda _r: httpx.Response(200, json={"members": []})),
    ) as client:
        h = client.members("s1")
        assert h.site_id == "s1"


@pytest.mark.asyncio
async def test_list_parses_members_and_normalises_role() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "members": [
                    {"uid": "u1", "email": "owner@x", "role": "owner", "displayName": "Owner"},
                    {"uid": "u2", "email": "a@x", "role": "admin"},
                    # Unrecognised roles fall back to 'member'.
                    {"uid": "u3", "email": "x@x", "role": "guest"},
                ]
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        rows = await client.members("s1").list()

    assert captured[0].url.path == "/api/sites/s1/members"
    assert [m.role for m in rows] == ["owner", "admin", "member"]


@pytest.mark.asyncio
async def test_add_emits_post_with_body_and_idempotency_key() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"uid": "u9", "role": "admin"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.members("s1").add("u9", role="admin")

    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/sites/s1/members"
    assert json.loads(req.content) == {"uid": "u9", "role": "admin"}
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_remove_uses_delete_with_explicit_idempotency_key() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"uid": "u9", "alreadyRemoved": False})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.members("s1").remove("u9")

    req = captured[0]
    assert req.method == "DELETE"
    assert req.url.path == "/api/sites/s1/members/u9"
    assert req.headers["Idempotency-Key"].startswith("py-sdk-members-remove-")
