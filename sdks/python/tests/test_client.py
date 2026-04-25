"""RoostClient HTTP-shape tests via httpx's MockTransport (ships with httpx, no extra dep)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def make_transport(
    handler: "callable[[httpx.Request], httpx.Response]",
) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_headers_injected_on_post() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["req"] = request
        return httpx.Response(200, json={"ok": True})

    async with Roost(
        token="owk_live_testtoken",
        transport=make_transport(handler),
    ) as client:
        await client.http.request("/api/roosts", method="POST", body={"siteId": "s"})

    req = captured["req"]
    assert req.headers["Authorization"] == "Bearer owk_live_testtoken"
    assert req.headers["Roost-Version"]
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_no_idempotency_on_get() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["req"] = request
        return httpx.Response(200, json={"sites": []})

    async with Roost(
        token="owk_live_x",
        transport=make_transport(handler),
    ) as client:
        await client.sites.list()

    assert "Idempotency-Key" not in captured["req"].headers


@pytest.mark.asyncio
async def test_query_params_translated() -> None:
    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["req"] = request
        return httpx.Response(200, json={"roosts": [], "nextPageToken": ""})

    async with Roost(
        token="owk_live_x",
        api_url="https://api.test",
        transport=make_transport(handler),
    ) as client:
        await client.roosts.list_page(site_id="site-1", page_size=5)

    url = str(captured["req"].url)
    assert "siteId=site-1" in url
    assert "limit=5" in url


@pytest.mark.asyncio
async def test_raises_roost_api_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": "validation_failed",
                "detail": "siteId required",
                "requestId": "req-abc",
            },
        )

    async with Roost(
        token="owk_live_x",
        transport=make_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.http.request("/api/roosts", method="POST", body={})
        err = excinfo.value
        assert err.status == 400
        assert err.code == "validation_failed"
        assert err.request_id == "req-abc"


@pytest.mark.asyncio
async def test_retries_on_429_then_succeeds() -> None:
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(429, json={"retryAfter": 0.001})
        return httpx.Response(200, json={"sites": [{"id": "s", "name": "x"}]})

    async with Roost(
        token="owk_live_x",
        transport=make_transport(handler),
        retry=RetryPolicy(max_attempts=5, base_delay_s=0.001, max_delay_s=0.01, jitter=0.0),
    ) as client:
        sites = await client.sites.list()

    assert attempts["n"] == 3
    assert sites[0].id == "s"


@pytest.mark.asyncio
async def test_does_not_retry_400() -> None:
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(400, json={"detail": "bad"})

    async with Roost(
        token="owk_live_x",
        transport=make_transport(handler),
        retry=RetryPolicy(max_attempts=5, base_delay_s=0.001, max_delay_s=0.01, jitter=0.0),
    ) as client:
        with pytest.raises(RoostApiError):
            await client.sites.list()

    assert attempts["n"] == 1


@pytest.mark.asyncio
async def test_roost_resource_shapes() -> None:
    """Exercise roosts.get, rollback, deploy payload shapes."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path.endswith("/rollback"):
            return httpx.Response(200, json={
                "currentVersionId": "to",
                "previousVersionId": "from",
            })
        if request.url.path.endswith("/deploy"):
            return httpx.Response(200, json={
                "rolloutId": "m",
                "versionId": "m",
                "siteId": "s",
                "roostId": "rst",
                "stage": "canary",
                "canary": ["m-1"],
                "fleet": [],
                "extractRoot": "~/x",
                "versionUrl": "https://r2/x",
            })
        return httpx.Response(200, json={
            "roostId": "rst",
            "siteId": "s",
            "name": "x",
            "targets": [],
            "extractPath": None,
            "schemaVersion": 2,
            "versionCounter": 0,
            "currentVersionId": None,
            "previousVersionId": None,
            "versionUrl": None,
            "createdAt": None,
            "updatedAt": None,
            "deletedAt": None,
            "currentVersion": None,
            "previousVersion": None,
        })

    async with Roost(
        token="owk_live_x",
        transport=make_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        from roost import DeployOptions, RollbackOptions

        await client.roosts.get("rst_abc", site_id="s1")
        await client.roosts.rollback("rst_abc", RollbackOptions(site_id="s1", target_version="to"))
        await client.roosts.deploy("rst_abc", DeployOptions(site_id="s1", dry_run=True))

    assert captured[0].url.path == "/api/roosts/rst_abc"
    assert captured[0].url.query.decode() == "siteId=s1"

    assert captured[1].url.path == "/api/roosts/rst_abc/rollback"
    rollback_body = json.loads(captured[1].content)
    assert rollback_body == {"siteId": "s1", "targetVersion": "to"}

    assert captured[2].url.path == "/api/roosts/rst_abc/deploy"
    deploy_body = json.loads(captured[2].content)
    assert deploy_body["dryRun"] is True
