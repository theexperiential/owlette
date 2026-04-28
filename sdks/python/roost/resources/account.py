"""``roost.account`` — caller identity, API version, and account key helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from roost.resources.keys import ApiKeyRecord, ApiKeyScope

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class AccountKeyContext:
    key_id: str | None
    name: str | None
    key_prefix: str | None
    scopes: list[ApiKeyScope] | None
    environment: str | None
    expires_at: int | None
    last_used_at: int | None
    is_legacy: bool


@dataclass(slots=True)
class WhoamiResponse:
    user_id: str | None
    email: str | None
    role: str | None
    key: AccountKeyContext | None
    rate_limit: dict[str, Any] | None
    quota: dict[str, Any] | None
    primary_site_id: str | None


@dataclass(slots=True)
class ApiVersionResponse:
    current: str
    supported: list[str]
    deprecated: list[str]
    retired: list[str]


def _parse_key_context(raw: Any) -> AccountKeyContext | None:
    if not isinstance(raw, dict):
        return None
    scopes_raw = raw.get("scopes")
    scopes: list[ApiKeyScope] | None = None
    if isinstance(scopes_raw, list):
        scopes = [
            ApiKeyScope.from_payload(scope)
            for scope in scopes_raw
            if isinstance(scope, dict)
        ]
    return AccountKeyContext(
        key_id=raw.get("keyId") if isinstance(raw.get("keyId"), str) else None,
        name=raw.get("name") if isinstance(raw.get("name"), str) else None,
        key_prefix=raw.get("keyPrefix") if isinstance(raw.get("keyPrefix"), str) else None,
        scopes=scopes,
        environment=raw.get("environment") if isinstance(raw.get("environment"), str) else None,
        expires_at=raw.get("expiresAt") if isinstance(raw.get("expiresAt"), int) else None,
        last_used_at=raw.get("lastUsedAt") if isinstance(raw.get("lastUsedAt"), int) else None,
        is_legacy=bool(raw.get("isLegacy", False)),
    )


def _parse_whoami(raw: dict[str, Any]) -> WhoamiResponse:
    rate_limit = raw.get("rateLimit") if isinstance(raw.get("rateLimit"), dict) else None
    quota = raw.get("quota") if isinstance(raw.get("quota"), dict) else None
    return WhoamiResponse(
        user_id=raw.get("userId") if isinstance(raw.get("userId"), str) else None,
        email=raw.get("email") if isinstance(raw.get("email"), str) else None,
        role=raw.get("role") if isinstance(raw.get("role"), str) else None,
        key=_parse_key_context(raw.get("key")),
        rate_limit=rate_limit,
        quota=quota,
        primary_site_id=raw.get("primarySiteId")
        if isinstance(raw.get("primarySiteId"), str)
        else None,
    )


def _parse_version(raw: dict[str, Any]) -> ApiVersionResponse:
    supported = raw.get("supported")
    deprecated = raw.get("deprecated")
    retired = raw.get("retired")
    return ApiVersionResponse(
        current=str(raw.get("current", "")),
        supported=[str(v) for v in supported] if isinstance(supported, list) else [],
        deprecated=[str(v) for v in deprecated] if isinstance(deprecated, list) else [],
        retired=[str(v) for v in retired] if isinstance(retired, list) else [],
    )


class AccountApiKeys:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(self) -> list[ApiKeyRecord]:
        resp = await self._client.request("/api/account/api-keys")
        data = resp.data if isinstance(resp.data, dict) else {}
        keys = data.get("keys", [])
        return [
            ApiKeyRecord.from_payload(key)
            for key in keys
            if isinstance(key, dict)
        ]

    async def create(self, *, name: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        resp = await self._client.request(
            "/api/account/api-keys",
            method="POST",
            body=body,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def revoke(self, key_id: str) -> None:
        await self._client.request(
            f"/api/account/api-keys/{key_id}",
            method="DELETE",
        )


class Account:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client
        self._api_keys: AccountApiKeys | None = None

    @property
    def api_keys(self) -> AccountApiKeys:
        if self._api_keys is None:
            self._api_keys = AccountApiKeys(self._client)
        return self._api_keys

    async def whoami(self) -> WhoamiResponse:
        resp = await self._client.request("/api/whoami")
        return _parse_whoami(resp.data if isinstance(resp.data, dict) else {})

    async def version(self) -> ApiVersionResponse:
        resp = await self._client.request("/api/version")
        return _parse_version(resp.data if isinstance(resp.data, dict) else {})


__all__ = [
    "Account",
    "AccountApiKeys",
    "AccountKeyContext",
    "ApiVersionResponse",
    "WhoamiResponse",
]
