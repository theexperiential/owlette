"""``roost.keys`` — scoped API key management."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from roost.client import RoostClient


Permission = Literal["read", "write", "deploy", "rollback", "admin"]
Resource = Literal["roost", "site", "machine"]


@dataclass(slots=True)
class ApiKeyScope:
    resource: Resource
    id: str
    permissions: list[Permission]

    def to_payload(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "id": self.id,
            "permissions": list(self.permissions),
        }


@dataclass(slots=True)
class ApiKeyRecord:
    id: str
    name: str | None
    key_prefix: str | None
    environment: Literal["live", "test"] | None
    scopes: list[ApiKeyScope] | None
    expires_at: int | None
    last_used_at: int | None
    rotated_at: int | None
    retires_at: int | None
    revoked_at: int | None
    expired: bool
    retired: bool


def _parse_scope(raw: dict[str, Any]) -> ApiKeyScope:
    resource = str(raw.get("resource", ""))
    if resource not in ("roost", "site", "machine"):
        resource = "site"
    perms = raw.get("permissions") or []
    return ApiKeyScope(
        resource=resource,  # type: ignore[arg-type]
        id=str(raw.get("id", "")),
        permissions=[p for p in perms if p in ("read", "write", "deploy", "rollback", "admin")],
    )


def _parse_record(raw: dict[str, Any]) -> ApiKeyRecord:
    scopes_raw = raw.get("scopes")
    scopes: list[ApiKeyScope] | None = None
    if isinstance(scopes_raw, list):
        scopes = [_parse_scope(s) for s in scopes_raw if isinstance(s, dict)]
    env = raw.get("environment")
    if env not in ("live", "test"):
        env = None
    return ApiKeyRecord(
        id=str(raw.get("id", "")),
        name=raw.get("name"),
        key_prefix=raw.get("keyPrefix"),
        environment=env,
        scopes=scopes,
        expires_at=raw.get("expiresAt"),
        last_used_at=raw.get("lastUsedAt"),
        rotated_at=raw.get("rotatedAt"),
        retires_at=raw.get("retiresAt"),
        revoked_at=raw.get("revokedAt"),
        expired=bool(raw.get("expired", False)),
        retired=bool(raw.get("retired", False)),
    )


class Keys:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def create(
        self,
        *,
        name: str,
        scopes: Sequence[ApiKeyScope],
        ttl_days: int = 90,
        environment: Literal["live", "test"] = "live",
    ) -> dict[str, Any]:
        resp = await self._client.request(
            "/api/keys",
            method="POST",
            body={
                "name": name,
                "scopes": [s.to_payload() for s in scopes],
                "ttlDays": ttl_days,
                "environment": environment,
            },
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def list(self) -> list[ApiKeyRecord]:
        resp = await self._client.request("/api/keys")
        data = resp.data if isinstance(resp.data, dict) else {}
        return [_parse_record(k) for k in data.get("keys", []) if isinstance(k, dict)]

    async def rotate(self, key_id: str, *, ttl_days: int = 90) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/keys/{key_id}/rotate",
            method="POST",
            body={"ttlDays": ttl_days},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def revoke(self, key_id: str) -> None:
        await self._client.request(
            f"/api/keys/{key_id}",
            method="DELETE",
        )


__all__ = ["ApiKeyRecord", "ApiKeyScope", "Keys", "Permission", "Resource"]
