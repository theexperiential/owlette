"""``roost.machines`` — site → machine introspection."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class MachineSummary:
    id: str
    name: str
    online: bool
    last_heartbeat: str | None
    agent_version: str | None
    os: str | None
    current_roosts: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class MachineDetail:
    id: str
    site_id: str
    name: str
    online: bool
    last_heartbeat: str | None
    agent_version: str | None
    os: str | None
    hostname: str | None
    metrics: Any | None
    processes: list[dict[str, Any]]


@dataclass(slots=True)
class MachineDeployment:
    roost_id: str
    name: str
    current_version_id: str | None
    previous_version_id: str | None
    extract_path: str | None
    reported_version_id: str | None
    reported_status: str | None
    reported_at: str | None


class Machines:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def list(self, site_id: str) -> list[MachineSummary]:
        resp = await self._client.request(f"/api/sites/{site_id}/machines")
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            MachineSummary(
                id=str(m.get("id", "")),
                name=str(m.get("name", "")),
                online=bool(m.get("online", False)),
                last_heartbeat=m.get("lastHeartbeat"),
                agent_version=m.get("agentVersion"),
                os=m.get("os"),
                current_roosts=list(m.get("currentRoosts") or []),
            )
            for m in data.get("machines", [])
            if isinstance(m, dict)
        ]

    async def get(self, site_id: str, machine_id: str) -> MachineDetail:
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}"
        )
        m = resp.data if isinstance(resp.data, dict) else {}
        return MachineDetail(
            id=str(m.get("id", "")),
            site_id=str(m.get("siteId", site_id)),
            name=str(m.get("name", "")),
            online=bool(m.get("online", False)),
            last_heartbeat=m.get("lastHeartbeat"),
            agent_version=m.get("agentVersion"),
            os=m.get("os"),
            hostname=m.get("hostname"),
            metrics=m.get("metrics"),
            processes=list(m.get("processes") or []),
        )

    async def deployments(self, site_id: str, machine_id: str) -> list[MachineDeployment]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/machines/{machine_id}/deployments"
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            MachineDeployment(
                roost_id=str(d.get("roostId", "")),
                name=str(d.get("name", "")),
                current_version_id=d.get("currentVersionId"),
                previous_version_id=d.get("previousVersionId"),
                extract_path=d.get("extractPath"),
                reported_version_id=d.get("reportedVersionId"),
                reported_status=d.get("reportedStatus"),
                reported_at=d.get("reportedAt"),
            )
            for d in data.get("deployments", [])
            if isinstance(d, dict)
        ]


__all__ = ["MachineDeployment", "MachineDetail", "MachineSummary", "Machines"]
