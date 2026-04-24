"""``roost.deployments`` — per-roost rollout history + detail."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


class Deployments:
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
                f"/api/roosts/{roost_id}/deployments",
                query={"siteId": site_id, "limit": page_size, "cursor": cursor},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            for r in data.get("rollouts", []):
                if isinstance(r, dict):
                    yield r
            next_token = str(data.get("nextPageToken") or "")
            if not next_token:
                return
            cursor = next_token

    async def get(
        self, roost_id: str, rollout_id: str, *, site_id: str
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/deployments/{rollout_id}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Deployments"]
