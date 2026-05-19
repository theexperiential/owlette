"""Tests for ``roost.quotas`` public API helpers."""

from __future__ import annotations

import httpx
import pytest

from roost import Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_current_quota_uses_public_site_path() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "siteId": "site-1",
                "tier": "pro",
                "usedBytes": 100,
                "pendingBytes": 25,
                "committedBytes": 125,
                "limitBytes": 1000,
                "fractionUsed": 0.125,
                "unlimited": False,
                "lastAlarmLevel": 0,
                "lastAlarmAt": None,
                "lastReconciledAt": None,
                "alarms": [],
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.quotas.current("site-1")

    assert out.committed_bytes == 125
    assert captured[0].method == "GET"
    assert captured[0].url.path == "/api/sites/site-1/quota"


@pytest.mark.asyncio
async def test_history_quota_uses_period_query() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"siteId": "site-1", "period": "7d", "days": 7, "daily": []},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.quotas.history("site-1", period="7d")

    assert out["days"] == 7
    assert captured[0].method == "GET"
    assert captured[0].url.path == "/api/sites/site-1/quota/history"
    assert captured[0].url.query.decode() == "period=7d"
