"""``roost.versions`` — version detail + file listing + diff.

A ``version_ref`` accepts any of the forms resolved server-side:
a positive integer (``"3"``), ``"#3"`` / ``"v3"``, a ``"vrs_*"`` id,
or the aliases ``"current"`` / ``"previous"`` / ``"first"``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


class Versions:
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
                f"/api/roosts/{roost_id}/versions",
                query={"siteId": site_id, "limit": page_size, "cursor": cursor},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for v in data.get("versions", []):
                if isinstance(v, dict):
                    yield v
            cursor = data.get("nextCursor")
            if not cursor:
                return

    async def get(
        self, roost_id: str, version_ref: str | int, *, site_id: str
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/versions/{version_ref}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def files(
        self,
        roost_id: str,
        version_ref: str | int,
        *,
        site_id: str,
        page_size: int = 100,
    ) -> AsyncIterator[dict[str, Any]]:
        cursor: str | None = None
        while True:
            resp = await self._client.request(
                f"/api/roosts/{roost_id}/versions/{version_ref}/files",
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
        *,
        site_id: str,
        from_version: str | int,
        to_version: str | int,
    ) -> dict[str, Any]:
        """Diff ``to_version`` against ``from_version``.

        Both accept any ``version_ref`` form (id / number / alias).
        """
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/versions/{to_version}/diff",
            query={"siteId": site_id, "against": from_version},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Versions"]
