"""``roost.sites`` — read-only site listing + detail."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class Site:
    id: str
    name: str
    plan: str | None
    timezone: str | None
    owner: str | None
    created_at: str | None


def _parse(raw: dict[str, Any]) -> Site:
    return Site(
        id=str(raw.get("id", "")),
        name=str(raw.get("name", "")),
        plan=raw.get("plan"),
        timezone=raw.get("timezone"),
        owner=raw.get("owner"),
        created_at=raw.get("createdAt"),
    )


class Sites:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(self) -> list[Site]:
        resp = await self._client.request("/api/sites")
        data = resp.data if isinstance(resp.data, dict) else {}
        return [_parse(s) for s in data.get("sites", []) if isinstance(s, dict)]

    async def get(self, site_id: str) -> Site:
        resp = await self._client.request(f"/api/sites/{site_id}")
        return _parse(resp.data if isinstance(resp.data, dict) else {})


__all__ = ["Site", "Sites"]
