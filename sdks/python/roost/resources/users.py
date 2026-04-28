"""``roost.users`` — platform user management (wave 3B, superadmin).

Drives:

  GET    /api/users
  GET    /api/users/{uid}
  POST   /api/users/{uid}/promote          { role }
  POST   /api/users/{uid}/demote
  POST   /api/users/{uid}/assign-sites     { siteIds }
  POST   /api/users/{uid}/remove-sites     { siteIds }
  DELETE /api/users/{uid}?successorUid=…

Two stable conflict codes get surfaced cleanly so callers can branch on
the typed exception's ``code`` attribute:
  - ``last_superadmin`` — ``demote`` would leave too few superadmins
  - ``orphan_sites``    — ``delete`` target owns sites; pass ``successor_uid``
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from roost.client import RoostClient


PromoteRole = Literal["admin", "superadmin"]


@dataclass(slots=True)
class PlatformUser:
    uid: str
    email: str | None
    role: str
    sites: list[str] = field(default_factory=list)
    display_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    created_at: str | None = None
    deleted_at: int | None = None


def _parse_user(raw: dict[str, Any]) -> PlatformUser:
    sites_raw = raw.get("sites")
    sites = [str(s) for s in sites_raw if isinstance(s, str)] if isinstance(sites_raw, list) else []
    return PlatformUser(
        uid=str(raw.get("uid", "")),
        email=raw.get("email"),
        role=str(raw.get("role", "member")),
        sites=sites,
        display_name=raw.get("displayName"),
        first_name=raw.get("firstName"),
        last_name=raw.get("lastName"),
        created_at=raw.get("createdAt"),
        deleted_at=raw.get("deletedAt"),
    )


class Users:
    """Platform user management (wave 3B, superadmin-only)."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(
        self,
        *,
        role: str | None = None,
        site: str | None = None,
        include_deleted: bool = False,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List platform users. Returns ``{users, next_page_token}``."""
        query: dict[str, Any] = {}
        if role is not None:
            query["role"] = role
        if site is not None:
            query["site"] = site
        if include_deleted:
            query["includeDeleted"] = True
        if page_size is not None:
            query["page_size"] = page_size
        if page_token:
            query["page_token"] = page_token
        resp = await self._client.request("/api/users", query=query or None)
        data = resp.data if isinstance(resp.data, dict) else {}
        users = [
            _parse_user(u)
            for u in (data.get("users") or [])
            if isinstance(u, dict)
        ]
        return {
            "users": users,
            "next_page_token": str(data.get("nextPageToken") or ""),
        }

    async def get(self, uid: str) -> PlatformUser:
        resp = await self._client.request(f"/api/users/{uid}")
        return _parse_user(resp.data if isinstance(resp.data, dict) else {})

    async def promote(
        self,
        uid: str,
        *,
        role: PromoteRole,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/users/{uid}/promote",
            method="POST",
            body={"role": role},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def demote(
        self,
        uid: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Demote a user back to ``member``.

        Raises ``RoostApiError`` with ``code='last_superadmin'`` (status 409)
        if the demotion would leave fewer than the configured floor of
        active superadmins.
        """
        resp = await self._client.request(
            f"/api/users/{uid}/demote",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def assign_sites(
        self,
        uid: str,
        site_ids: Sequence[str],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if not site_ids:
            msg = "users.assign_sites: site_ids must not be empty"
            raise ValueError(msg)
        resp = await self._client.request(
            f"/api/users/{uid}/assign-sites",
            method="POST",
            body={"siteIds": list(site_ids)},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def remove_sites(
        self,
        uid: str,
        site_ids: Sequence[str],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if not site_ids:
            msg = "users.remove_sites: site_ids must not be empty"
            raise ValueError(msg)
        resp = await self._client.request(
            f"/api/users/{uid}/remove-sites",
            method="POST",
            body={"siteIds": list(site_ids)},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def delete(
        self,
        uid: str,
        *,
        successor_uid: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Soft-delete a platform user.

        If the target owns any sites, pass ``successor_uid`` to transfer
        them; otherwise the server returns 409 ``orphan_sites``.
        """
        # Preserve a resource-specific prefix rather than the core client's
        # generic py-sdk DELETE key.
        idem = idempotency_key or f"py-sdk-users-delete-{uuid.uuid4()}"
        query: dict[str, Any] = {}
        if successor_uid is not None:
            query["successorUid"] = successor_uid
        resp = await self._client.request(
            f"/api/users/{uid}",
            method="DELETE",
            query=query or None,
            headers={"Idempotency-Key": idem},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["PlatformUser", "PromoteRole", "Users"]
