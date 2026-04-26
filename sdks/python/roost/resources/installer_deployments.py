"""``roost.installer_deployments`` — classic-installer deployment lifecycle.

Drives the wave-1A site-scoped routes:

  POST   /api/sites/{siteId}/deployments
  GET    /api/sites/{siteId}/deployments
  GET    /api/sites/{siteId}/deployments/{deploymentId}
  POST   /api/sites/{siteId}/deployments/{deploymentId}/retry
  POST   /api/sites/{siteId}/deployments/{deploymentId}/cancel
  POST   /api/sites/{siteId}/deployments/{deploymentId}/uninstall

Note: this is the *classic installer* deploy noun, distinct from the
content-addressed atomic roost deploy (``roost.roosts.deploy``). The
two surfaces share no state.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class InstallerDeploymentTarget:
    machine_id: str
    status: str
    error: str | None = None


@dataclass(slots=True)
class InstallerDeploymentSummary:
    id: str
    name: str
    installer_name: str
    installer_url: str
    silent_flags: str
    verify_path: str | None
    sha256_checksum: str | None
    parallel_install: bool
    targets: list[InstallerDeploymentTarget] = field(default_factory=list)
    status: str = "pending"
    created_at: str | None = None
    completed_at: str | None = None
    updated_at: str | None = None


@dataclass(slots=True)
class InstallerDeploymentDetail:
    id: str
    site_id: str
    name: str
    installer_name: str
    installer_url: str
    silent_flags: str
    verify_path: str | None
    sha256_checksum: str | None
    parallel_install: bool
    targets: list[InstallerDeploymentTarget] = field(default_factory=list)
    status: str = "pending"
    created_at: str | None = None
    completed_at: str | None = None
    updated_at: str | None = None


def _parse_target(raw: dict[str, Any]) -> InstallerDeploymentTarget:
    err = raw.get("error")
    return InstallerDeploymentTarget(
        machine_id=str(raw.get("machineId", "")),
        status=str(raw.get("status", "")),
        error=str(err) if isinstance(err, str) else None,
    )


def _parse_summary(raw: dict[str, Any]) -> InstallerDeploymentSummary:
    targets = [
        _parse_target(t)
        for t in (raw.get("targets") or [])
        if isinstance(t, dict)
    ]
    return InstallerDeploymentSummary(
        id=str(raw.get("id", "")),
        name=str(raw.get("name", "")),
        installer_name=str(raw.get("installer_name", "")),
        installer_url=str(raw.get("installer_url", "")),
        silent_flags=str(raw.get("silent_flags", "")),
        verify_path=raw.get("verify_path"),
        sha256_checksum=raw.get("sha256_checksum"),
        parallel_install=bool(raw.get("parallel_install", False)),
        targets=targets,
        status=str(raw.get("status", "pending")),
        created_at=raw.get("createdAt"),
        completed_at=raw.get("completedAt"),
        updated_at=raw.get("updatedAt"),
    )


def _parse_detail(raw: dict[str, Any]) -> InstallerDeploymentDetail:
    targets = [
        _parse_target(t)
        for t in (raw.get("targets") or [])
        if isinstance(t, dict)
    ]
    return InstallerDeploymentDetail(
        id=str(raw.get("id", "")),
        site_id=str(raw.get("siteId", "")),
        name=str(raw.get("name", "")),
        installer_name=str(raw.get("installer_name", "")),
        installer_url=str(raw.get("installer_url", "")),
        silent_flags=str(raw.get("silent_flags", "")),
        verify_path=raw.get("verify_path"),
        sha256_checksum=raw.get("sha256_checksum"),
        parallel_install=bool(raw.get("parallel_install", False)),
        targets=targets,
        status=str(raw.get("status", "pending")),
        created_at=raw.get("createdAt"),
        completed_at=raw.get("completedAt"),
        updated_at=raw.get("updatedAt"),
    )


class InstallerDeployments:
    """Classic agent-installer deployments (wave 1A)."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(
        self,
        site_id: str,
        *,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List deployments. Returns the raw page envelope ``{items, next_page_token}``."""
        query: dict[str, Any] = {}
        if page_size is not None:
            query["page_size"] = page_size
        if page_token:
            query["page_token"] = page_token
        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments",
            query=query or None,
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        items = [
            _parse_summary(item)
            for item in (data.get("items") or [])
            if isinstance(item, dict)
        ]
        return {
            "items": items,
            "next_page_token": str(data.get("next_page_token") or ""),
        }

    async def get(self, site_id: str, deployment_id: str) -> InstallerDeploymentDetail:
        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments/{deployment_id}",
        )
        return _parse_detail(resp.data if isinstance(resp.data, dict) else {})

    async def create(
        self,
        site_id: str,
        *,
        name: str,
        installer_name: str,
        installer_url: str,
        silent_flags: str,
        machines: Sequence[str],
        verify_path: str | None = None,
        sha256_checksum: str | None = None,
        parallel_install: bool = False,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "installer_name": installer_name,
            "installer_url": installer_url,
            "silent_flags": silent_flags,
            "machines": list(machines),
        }
        if verify_path is not None:
            body["verify_path"] = verify_path
        if sha256_checksum is not None:
            body["sha256_checksum"] = sha256_checksum
        if parallel_install:
            body["parallel_install"] = True

        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments",
            method="POST",
            body=body,
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def retry(
        self,
        site_id: str,
        deployment_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments/{deployment_id}/retry",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def cancel(
        self,
        site_id: str,
        deployment_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments/{deployment_id}/cancel",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def uninstall(
        self,
        site_id: str,
        deployment_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/deployments/{deployment_id}/uninstall",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = [
    "InstallerDeploymentDetail",
    "InstallerDeploymentSummary",
    "InstallerDeploymentTarget",
    "InstallerDeployments",
]
