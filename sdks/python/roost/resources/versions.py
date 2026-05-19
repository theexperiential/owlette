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

    async def list_page(
        self,
        roost_id: str,
        *,
        site_id: str,
        page_size: int = 20,
        page_token: str | None = None,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        """One page of versions. Returns ``(versions, next_page_token)``."""
        token = page_token if page_token is not None else cursor
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/versions",
            query={"siteId": site_id, "page_size": page_size, "page_token": token},
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        versions = [v for v in data.get("versions", []) if isinstance(v, dict)]
        next_token = (
            data.get("nextPageToken")
            or data.get("next_page_token")
            or data.get("nextCursor")
            or ""
        )
        return versions, str(next_token)

    async def list(
        self,
        roost_id: str,
        *,
        site_id: str,
        page_size: int = 20,
        page_token: str | None = None,
        cursor: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        token: str | None = page_token if page_token is not None else cursor
        while True:
            rows, token = await self.list_page(
                roost_id,
                site_id=site_id,
                page_size=page_size,
                page_token=token,
            )
            for v in rows:
                yield v
            if not token:
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
        page_token: str | None = None,
        cursor: str | None = None,
        prefix: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        token: str | None = page_token if page_token is not None else cursor
        while True:
            resp = await self._client.request(
                f"/api/roosts/{roost_id}/versions/{version_ref}/files",
                query={
                    "siteId": site_id,
                    "page_size": page_size,
                    "page_token": token,
                    "prefix": prefix,
                },
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for f in data.get("files", []) or data.get("items", []):
                if isinstance(f, dict):
                    yield f
            token = str(data.get("nextPageToken") or data.get("next_page_token") or "")
            if not token:
                return

    async def patch(
        self,
        roost_id: str,
        version_ref: str | int,
        *,
        site_id: str,
        description: str | None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Patch mutable version metadata."""
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/versions/{version_ref}",
            method="PATCH",
            body={"siteId": site_id, "description": description},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def diff(
        self,
        roost_id: str,
        version_ref: str | int | None = None,
        *,
        site_id: str,
        against: str | int | None = None,
        from_version: str | int | None = None,
        to_version: str | int | None = None,
    ) -> dict[str, Any]:
        """Diff ``version_ref`` against ``against``.

        Both accept any ``version_ref`` form (id / number / alias).
        """
        target = version_ref if version_ref is not None else to_version
        baseline = against if against is not None else from_version
        if target is None or baseline is None:
            msg = "versions.diff requires version_ref and against"
            raise ValueError(msg)
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/versions/{target}/diff",
            query={"siteId": site_id, "against": str(baseline)},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Versions"]
