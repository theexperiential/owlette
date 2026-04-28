"""Public API pagination and version metadata route-shape tests."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_versions_list_page_uses_canonical_pagination() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "versions": [{"versionId": "vrs_1", "versionNumber": 1}],
                "next_page_token": "vrs_next",
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        rows, token = await client.versions.list_page(
            "rst_1",
            site_id="site-1",
            page_size=10,
            page_token="vrs_0",
        )

    assert rows[0]["versionId"] == "vrs_1"
    assert token == "vrs_next"
    assert captured[0].url.path == "/api/roosts/rst_1/versions"
    query = captured[0].url.query.decode()
    assert "siteId=site-1" in query
    assert "page_size=10" in query
    assert "page_token=vrs_0" in query
    assert "limit=" not in query
    assert "cursor=" not in query


@pytest.mark.asyncio
async def test_versions_patch_and_diff_use_public_shapes() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.method == "PATCH":
            return httpx.Response(
                200,
                json={"versionId": "vrs_1", "description": "notes"},
            )
        return httpx.Response(
            200,
            json={"summary": {"added": 0, "removed": 0, "changed": 0}},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        patched = await client.versions.patch(
            "rst_1",
            "vrs_1",
            site_id="site-1",
            description="notes",
            idempotency_key="idem-version-patch",
        )
        diff = await client.versions.diff(
            "rst_1",
            "current",
            site_id="site-1",
            against="previous",
        )

    assert patched["versionId"] == "vrs_1"
    assert diff["summary"]["added"] == 0
    assert captured[0].method == "PATCH"
    assert captured[0].url.path == "/api/roosts/rst_1/versions/vrs_1"
    assert captured[0].headers["Idempotency-Key"] == "idem-version-patch"
    assert json.loads(captured[0].content) == {
        "siteId": "site-1",
        "description": "notes",
    }
    assert captured[1].method == "GET"
    assert captured[1].url.path == "/api/roosts/rst_1/versions/current/diff"
    assert "against=previous" in captured[1].url.query.decode()


@pytest.mark.asyncio
async def test_versions_files_deployments_and_chunks_use_canonical_pagination() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json={"files": [{"path": "index.html"}]})
        if request.url.path.endswith("/deployments"):
            return httpx.Response(
                200,
                json={"items": [{"rolloutId": "rol_1"}], "next_page_token": ""},
            )
        if request.url.path.endswith("/referrers"):
            return httpx.Response(
                200,
                json={"items": [{"roostId": "rst_1"}], "next_page_token": ""},
            )
        return httpx.Response(404, json={"detail": "unexpected path"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        files = [
            row
            async for row in client.versions.files(
                "rst_1",
                "current",
                site_id="site-1",
                page_size=25,
                page_token="10",
                prefix="assets/",
            )
        ]
        deployments, _ = await client.deployments.list_page(
            "rst_1",
            site_id="site-1",
            page_size=5,
            page_token="rol_0",
        )
        refs = [
            row
            async for row in client.chunks.referrers(
                "sha256:abc",
                site_id="site-1",
                page_size=3,
                page_token="ref_0",
            )
        ]

    assert files == [{"path": "index.html"}]
    assert deployments == [{"rolloutId": "rol_1"}]
    assert refs == [{"roostId": "rst_1"}]

    file_query = captured[0].url.query.decode()
    assert "page_size=25" in file_query
    assert "page_token=10" in file_query
    assert "prefix=assets%2F" in file_query
    deployments_query = captured[1].url.query.decode()
    assert "page_size=5" in deployments_query
    assert "page_token=rol_0" in deployments_query
    refs_query = captured[2].url.query.decode()
    assert "page_size=3" in refs_query
    assert "page_token=ref_0" in refs_query
