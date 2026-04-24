"""``roost.manifests`` — manifest detail + file listing + diff."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


class Manifests:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(
        self,
        roost_id: str,
        *,
        site_id: str,
        page_size: int = 20,
    ) -> AsyncIterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            resp = await self._client.request(
                f"/api/roosts/{roost_id}/manifests",
                query={"siteId": site_id, "limit": page_size, "cursor": cursor},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for m in data.get("manifests", []):
                if isinstance(m, dict):
                    yield m
            cursor = data.get("nextCursor")
            if not cursor:
                return

    async def get(
        self, roost_id: str, manifest_id: str, *, site_id: str
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/manifests/{manifest_id}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def files(
        self,
        roost_id: str,
        manifest_id: str,
        *,
        site_id: str,
        page_size: int = 100,
    ) -> AsyncIterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            resp = await self._client.request(
                f"/api/roosts/{roost_id}/manifests/{manifest_id}/files",
                query={"siteId": site_id, "limit": page_size, "cursor": cursor},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for f in data.get("files", []):
                if isinstance(f, dict):
                    yield f
            next_token = str(data.get("nextPageToken") or "")
            if not next_token:
                return
            cursor = next_token

    async def diff(
        self,
        roost_id: str,
        manifest_id: str,
        *,
        site_id: str,
        against: str,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/manifests/{manifest_id}/diff",
            query={"siteId": site_id, "against": against},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Manifests"]
