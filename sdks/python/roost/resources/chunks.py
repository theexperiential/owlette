"""``roost.chunks`` — raw chunk CAS operations."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


class Chunks:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def check(self, site_id: str, hashes: Sequence[str]) -> list[str]:
        resp = await self._client.request(
            "/api/chunks/check",
            method="POST",
            body={"siteId": site_id, "hashes": list(hashes)},
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        missing = data.get("missing", [])
        return [str(m) for m in missing]

    async def upload_urls(
        self, site_id: str, hashes: Sequence[str]
    ) -> dict[str, Any]:
        resp = await self._client.request(
            "/api/chunks/upload-urls",
            method="POST",
            body={"siteId": site_id, "hashes": list(hashes)},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def download_urls(
        self, site_id: str, hashes: Sequence[str]
    ) -> dict[str, Any]:
        resp = await self._client.request(
            "/api/chunks/download-urls",
            method="POST",
            body={"siteId": site_id, "hashes": list(hashes)},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def mount(
        self, digest: str, *, site_id: str, from_roost: str, to_roost: str
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/chunks/{digest}/mount",
            method="POST",
            query={"siteId": site_id, "from": from_roost, "to": to_roost},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def referrers(
        self,
        digest: str,
        *,
        site_id: str,
        page_size: int = 50,
    ) -> AsyncIterator[dict[str, Any]]:
        """Auto-paginating async generator over referrers."""
        cursor: str | None = None
        while True:
            resp = await self._client.request(
                f"/api/chunks/{digest}/referrers",
                query={"siteId": site_id, "limit": page_size, "cursor": cursor},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for entry in data.get("referrers", []):
                if isinstance(entry, dict):
                    yield entry
            next_token = str(data.get("nextPageToken") or "")
            if not next_token:
                return
            cursor = next_token


__all__ = ["Chunks"]
