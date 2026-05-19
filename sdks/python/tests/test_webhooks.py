"""Tests for ``roost.webhooks`` public API helpers."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_subscribe_posts_site_query_and_body() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(201, json={"id": "wh_1", "signingSecret": "whsec_1"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.webhooks.subscribe(
            site_id="site-1",
            url="https://hooks.example/roost",
            events=["version.published"],
        )

    assert out["id"] == "wh_1"
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/webhooks"
    assert req.url.query.decode() == "siteId=site-1"
    assert json.loads(req.content)["events"] == ["version.published"]


@pytest.mark.asyncio
async def test_delivery_helpers_use_public_paths() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path.endswith("/retry"):
            return httpx.Response(
                202,
                json={
                    "id": "del_retry",
                    "webhookId": "wh_1",
                    "siteId": "site-1",
                    "retryOf": "del_1",
                    "state": "pending",
                    "nextAttemptAt": "2026-04-28T00:00:00.000Z",
                },
            )
        if request.url.path.endswith("/deliveries/del_1"):
            return httpx.Response(200, json={"id": "del_1", "state": "failed"})
        return httpx.Response(
            200,
            json={"deliveries": [], "next_page_token": "", "nextPageToken": ""},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.webhooks.deliveries("wh_1", "site-1", page_size=10)
        await client.webhooks.delivery("wh_1", "del_1", "site-1")
        await client.webhooks.retry_delivery("wh_1", "del_1", "site-1")

    assert captured[0].method == "GET"
    assert captured[0].url.path == "/api/webhooks/wh_1/deliveries"
    assert "siteId=site-1" in captured[0].url.query.decode()
    assert "page_size=10" in captured[0].url.query.decode()
    assert captured[1].url.path == "/api/webhooks/wh_1/deliveries/del_1"
    assert captured[2].method == "POST"
    assert captured[2].url.path == "/api/webhooks/wh_1/deliveries/del_1/retry"
    assert captured[2].headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_probe_posts_site_query_url_and_event() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"status": 200})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.webhooks.probe(
            "site-1",
            "version.published",
            url="https://hooks.example/roost",
            payload={"roostId": "rst_1"},
            signing_secret="whsec_local_test_secret_000000000000",
        )

    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/api/webhooks/probe"
    assert req.url.query.decode() == "siteId=site-1"
    body = json.loads(req.content)
    assert body["url"] == "https://hooks.example/roost"
    assert body["event"] == "version.published"
    assert body["payload"] == {"roostId": "rst_1"}
