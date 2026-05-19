"""Tests for account identity, API version, and API-key-compatible key helpers."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_account_whoami_and_version_parse_public_routes() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/api/whoami":
            return httpx.Response(
                200,
                json={
                    "userId": "usr_1",
                    "email": "owner@example.com",
                    "role": "admin",
                    "primarySiteId": "site-1",
                    "key": {
                        "keyId": "key_1",
                        "name": "ci",
                        "keyPrefix": "owk_live_abcd",
                        "environment": "live",
                        "scopes": [
                            {"resource": "site", "id": "site-1", "permissions": ["read"]},
                        ],
                    },
                    "rateLimit": {"limit": 60},
                    "quota": {"siteId": "site-1"},
                },
            )
        if request.url.path == "/api/version":
            return httpx.Response(
                200,
                json={"current": "2026-04-22", "supported": ["2026-04-22"]},
            )
        return httpx.Response(404, json={"detail": "unexpected path"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        identity = await client.account.whoami()
        version = await client.account.version()

    assert identity.email == "owner@example.com"
    assert identity.primary_site_id == "site-1"
    assert identity.key is not None
    assert identity.key.key_prefix == "owk_live_abcd"
    assert identity.key.scopes is not None
    assert identity.key.scopes[0].resource == "site"
    assert version.current == "2026-04-22"
    assert captured[0].url.path == "/api/whoami"
    assert captured[1].url.path == "/api/version"


@pytest.mark.asyncio
async def test_account_api_keys_use_account_routes() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "keys": [
                        {
                            "id": "key_1",
                            "name": "ci",
                            "keyPrefix": "owk_live_abcd",
                            "environment": "live",
                            "scopes": [
                                {
                                    "resource": "roost",
                                    "id": "*",
                                    "permissions": ["read", "write"],
                                },
                            ],
                        },
                    ],
                },
            )
        if request.method == "POST":
            return httpx.Response(
                201,
                json={
                    "success": True,
                    "key": "owk_live_secret",
                    "keyId": "key_2",
                    "name": "preview",
                },
            )
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(405, json={"detail": "bad method"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        keys = await client.account.api_keys.list()
        created = await client.account.api_keys.create(name="preview")
        await client.account.api_keys.revoke("key_2")

    assert keys[0].id == "key_1"
    assert keys[0].environment == "live"
    assert keys[0].scopes is not None
    assert keys[0].scopes[0].permissions == ["read", "write"]
    assert created["keyId"] == "key_2"

    assert captured[0].method == "GET"
    assert captured[0].url.path == "/api/account/api-keys"
    assert captured[1].method == "POST"
    assert captured[1].url.path == "/api/account/api-keys"
    assert json.loads(captured[1].content) == {"name": "preview"}
    assert captured[2].method == "DELETE"
    assert captured[2].url.path == "/api/account/api-keys/key_2"
