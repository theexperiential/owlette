"""``roost.members`` — site membership (wave 3B).

Drives:

  GET    /api/sites/{siteId}/members
  POST   /api/sites/{siteId}/members          { uid, role }
  DELETE /api/sites/{siteId}/members/{uid}

Construct via ``roost.members(site_id)`` — each instance is bound to one
site. The per-site role is derived server-side (owner / superadmin /
admin / member) and surfaced on each ``Member.role``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from roost.client import RoostClient


AddRole = Literal["member", "admin"]
PerSiteRole = Literal["owner", "superadmin", "admin", "member"]


@dataclass(slots=True)
class Member:
    uid: str
    email: str | None
    role: PerSiteRole
    display_name: str | None


def _parse_member(raw: dict[str, Any]) -> Member:
    role = raw.get("role")
    if role not in ("owner", "superadmin", "admin", "member"):
        role = "member"
    return Member(
        uid=str(raw.get("uid", "")),
        email=raw.get("email"),
        role=role,  # type: ignore[arg-type]
        display_name=raw.get("displayName"),
    )


class Members:
    """Site-membership management bound to one site."""

    def __init__(self, client: "RoostClient", site_id: str) -> None:
        self._client = client
        self._site_id = site_id

    @property
    def site_id(self) -> str:
        return self._site_id

    def _base(self) -> str:
        return f"/api/sites/{self._site_id}/members"

    async def list(self) -> list[Member]:
        resp = await self._client.request(self._base())
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            _parse_member(m)
            for m in (data.get("members") or [])
            if isinstance(m, dict)
        ]

    async def add(
        self,
        uid: str,
        *,
        role: AddRole = "member",
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            self._base(),
            method="POST",
            body={"uid": uid, "role": role},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def remove(
        self,
        uid: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        # Preserve a resource-specific prefix rather than the core client's
        # generic py-sdk DELETE key.
        idem = idempotency_key or f"py-sdk-members-remove-{uuid.uuid4()}"
        resp = await self._client.request(
            f"{self._base()}/{uid}",
            method="DELETE",
            headers={"Idempotency-Key": idem},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["AddRole", "Member", "Members", "PerSiteRole"]
