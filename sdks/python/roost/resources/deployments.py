"""``roost.deployments`` — per-roost rollout history + detail."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


class Deployments:
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
        """One page of deployment rollouts. Returns ``(rollouts, next_page_token)``."""
        token = page_token if page_token is not None else cursor
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/deployments",
            query={"siteId": site_id, "page_size": page_size, "page_token": token},
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        rollouts = [r for r in data.get("rollouts", []) or data.get("items", []) if isinstance(r, dict)]
        next_token = data.get("nextPageToken") or data.get("next_page_token") or ""
        return rollouts, str(next_token)

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
            for r in rows:
                yield r
            if not token:
                return

    async def get(
        self, roost_id: str, rollout_id: str, *, site_id: str
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/deployments/{rollout_id}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Deployments"]
