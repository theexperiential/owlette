"""Tests for the session-authenticated ``/api/keys`` lifecycle helpers."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import ApiKeyScope, Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_update_patches_the_key_and_parses_the_refreshed_record() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "success": True,
                "key": {
                    "id": "key_1",
                    "name": "uploader",
                    "keyPrefix": "owk_live_abcd",
                    "environment": "live",
                    "scopes": [
                        {"resource": "installer", "id": "*", "permissions": ["read", "write"]},
                    ],
                    "expiresAt": 1798049400000,
                    "lastUsedAt": None,
                },
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        record = await client.keys.update(
            "key_1",
            scopes=[ApiKeyScope(resource="installer", id="*", permissions=["read", "write"])],
        )

    assert captured[0].method == "PATCH"
    assert captured[0].url.path == "/api/keys/key_1"
    # A full replacement, and `name` is absent rather than sent as null — the
    # route treats any present field as an edit.
    assert json.loads(captured[0].content) == {
        "scopes": [{"resource": "installer", "id": "*", "permissions": ["read", "write"]}],
    }
    assert record is not None
    assert record.scopes is not None
    assert record.scopes[0].resource == "installer"


@pytest.mark.asyncio
async def test_update_sends_a_name_only_patch() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"success": True, "key": {"id": "key_1"}})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.keys.update("key_1", name="renamed")

    assert json.loads(captured[0].content) == {"name": "renamed"}


@pytest.mark.asyncio
async def test_update_refuses_an_empty_patch_without_calling_the_api() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"success": True})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        with pytest.raises(ValueError):
            await client.keys.update("key_1")

    assert calls == []
