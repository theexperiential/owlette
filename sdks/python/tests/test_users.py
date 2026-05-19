"""Tests for ``roost.users`` (wave 3B)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_list_translates_filters_to_query_params() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "users": [
                    {
                        "uid": "u1",
                        "email": "a@b",
                        "role": "admin",
                        "sites": ["s1", "s2"],
                        "displayName": "Admin",
                        "createdAt": "2026-01-01T00:00:00Z",
                    }
                ],
                "nextPageToken": "tok",
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        page = await client.users.list(role="admin", site="s1", include_deleted=True, page_size=10)

    assert page["next_page_token"] == "tok"
    user = page["users"][0]
    assert user.uid == "u1"
    assert user.sites == ["s1", "s2"]
    qs = captured[0].url.query.decode()
    assert "role=admin" in qs
    assert "site=s1" in qs
    assert "includeDeleted=true" in qs
    assert "page_size=10" in qs


@pytest.mark.asyncio
async def test_promote_sends_role_body_and_idempotency() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"uid": "u1", "role": "superadmin", "previousRole": "admin", "changed": True},
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.users.promote("u1", role="superadmin")

    assert out["changed"] is True
    body = json.loads(captured[0].content)
    assert body == {"role": "superadmin"}
    assert captured[0].headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_demote_surfaces_last_superadmin_409() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={
                "code": "last_superadmin",
                "detail": "only one superadmin remains",
                "minSuperadmins": 1,
                "currentActiveCount": 1,
            },
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.users.demote("u1")
        assert excinfo.value.code == "last_superadmin"
        assert excinfo.value.problem.get("currentActiveCount") == 1


@pytest.mark.asyncio
async def test_assign_and_remove_sites_serialise_csv() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"uid": "u1", "assignedSiteIds": ["s1", "s2"]})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.users.assign_sites("u1", ["s1", "s2"])
        await client.users.remove_sites("u1", ("s1",))

    assert captured[0].url.path == "/api/users/u1/assign-sites"
    assert json.loads(captured[0].content) == {"siteIds": ["s1", "s2"]}
    assert captured[1].url.path == "/api/users/u1/remove-sites"
    assert json.loads(captured[1].content) == {"siteIds": ["s1"]}


@pytest.mark.asyncio
async def test_assign_sites_empty_list_raises_value_error() -> None:
    async with Roost(
        token="owk_live_x",
        transport=_transport(lambda _r: httpx.Response(200, json={})),
    ) as client:
        with pytest.raises(ValueError, match="must not be empty"):
            await client.users.assign_sites("u1", [])


@pytest.mark.asyncio
async def test_delete_with_successor_emits_query_param_and_idempotency() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"uid": "u1", "alreadyDeleted": False, "transferredSites": ["s1"]})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        out = await client.users.delete("u1", successor_uid="u2")

    assert out["transferredSites"] == ["s1"]
    req = captured[0]
    assert req.method == "DELETE"
    assert "successorUid=u2" in req.url.query.decode()
    assert req.headers["Idempotency-Key"].startswith("py-sdk-users-delete-")


@pytest.mark.asyncio
async def test_delete_orphan_sites_409_surfaces_typed_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"code": "orphan_sites", "detail": "owns sites", "ownedSites": ["s1", "s2"]},
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            await client.users.delete("u1")
        assert excinfo.value.code == "orphan_sites"
        assert excinfo.value.problem.get("ownedSites") == ["s1", "s2"]
