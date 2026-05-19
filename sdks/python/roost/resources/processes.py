"""``roost.processes`` — process lifecycle on a single machine.

Drives the wave-2B scoped process api:

  GET    /api/sites/{siteId}/machines/{machineId}/processes
  POST   /api/sites/{siteId}/machines/{machineId}/processes
  GET    /api/sites/{siteId}/machines/{machineId}/processes/{processId}
  PATCH  /api/sites/{siteId}/machines/{machineId}/processes/{processId}
  DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}
  POST   /api/sites/{siteId}/machines/{machineId}/processes/{processId}/kill
  POST   /api/sites/{siteId}/machines/{machineId}/processes/{processId}/start
  POST   /api/sites/{siteId}/machines/{machineId}/processes/{processId}/stop
  POST   /api/sites/{siteId}/machines/{machineId}/processes/{processId}/schedule

Construct via the factory ``roost.processes(site_id, machine_id)`` —
each instance is bound to one machine. The factory keeps the noun-verb
shape consistent with the CLI (`owlette process …`) without the caller
having to repeat the site/machine pair on every call.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from roost.client import RoostClient


ScheduleMode = Literal["off", "always", "scheduled"]
ControlVerb = Literal["kill", "start", "stop"]


@dataclass(slots=True)
class ProcessRecord:
    process_id: str
    name: str
    exe_path: str
    cwd: str
    priority: str
    visibility: str
    launch_mode: str
    autolaunch: bool
    status: str
    pid: int | None
    responsive: bool
    schedule: Any | None
    schedules: Any | None
    last_updated: str | int | None


def _parse_process(raw: dict[str, Any]) -> ProcessRecord:
    pid_raw = raw.get("pid")
    pid: int | None = pid_raw if isinstance(pid_raw, int) else None
    return ProcessRecord(
        process_id=str(raw.get("processId", "")),
        name=str(raw.get("name", "")),
        exe_path=str(raw.get("exe_path", "")),
        cwd=str(raw.get("cwd", "")),
        priority=str(raw.get("priority", "")),
        visibility=str(raw.get("visibility", "")),
        launch_mode=str(raw.get("launch_mode", "")),
        autolaunch=bool(raw.get("autolaunch", False)),
        status=str(raw.get("status", "")),
        pid=pid,
        responsive=bool(raw.get("responsive", False)),
        schedule=raw.get("schedule"),
        schedules=raw.get("schedules"),
        last_updated=raw.get("last_updated"),
    )


class Processes:
    """Process management bound to one (site, machine) pair."""

    def __init__(self, client: "RoostClient", site_id: str, machine_id: str) -> None:
        self._client = client
        self._site_id = site_id
        self._machine_id = machine_id

    @property
    def site_id(self) -> str:
        return self._site_id

    @property
    def machine_id(self) -> str:
        return self._machine_id

    def _base(self) -> str:
        return (
            f"/api/sites/{self._site_id}/machines/{self._machine_id}/processes"
        )

    async def list(self) -> list[ProcessRecord]:
        resp = await self._client.request(self._base())
        envelope = resp.data if isinstance(resp.data, dict) else {}
        # Server wraps response in `{ ok, data: { processes, nextPageToken } }`.
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        if not isinstance(payload, dict):
            return []
        return [
            _parse_process(p)
            for p in (payload.get("processes") or [])
            if isinstance(p, dict)
        ]

    async def get(self, process_id: str) -> ProcessRecord:
        resp = await self._client.request(f"{self._base()}/{process_id}")
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return _parse_process(payload if isinstance(payload, dict) else {})

    async def create(
        self,
        *,
        name: str,
        exe_path: str,
        cwd: str | None = None,
        priority: str | None = None,
        visibility: str | None = None,
        launch_mode: ScheduleMode | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"name": name, "exe_path": exe_path}
        if cwd is not None:
            body["cwd"] = cwd
        if priority is not None:
            body["priority"] = priority
        if visibility is not None:
            body["visibility"] = visibility
        if launch_mode is not None:
            body["launch_mode"] = launch_mode

        resp = await self._client.request(
            self._base(),
            method="POST",
            body=body,
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def update(
        self,
        process_id: str,
        *,
        name: str | None = None,
        exe_path: str | None = None,
        cwd: str | None = None,
        priority: str | None = None,
        visibility: str | None = None,
        launch_mode: ScheduleMode | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if exe_path is not None:
            body["exe_path"] = exe_path
        if cwd is not None:
            body["cwd"] = cwd
        if priority is not None:
            body["priority"] = priority
        if visibility is not None:
            body["visibility"] = visibility
        if launch_mode is not None:
            body["launch_mode"] = launch_mode
        if not body:
            msg = "processes.update: at least one field must be provided"
            raise ValueError(msg)

        resp = await self._client.request(
            f"{self._base()}/{process_id}",
            method="PATCH",
            body=body,
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def delete(self, process_id: str) -> dict[str, Any]:
        resp = await self._client.request(
            f"{self._base()}/{process_id}",
            method="DELETE",
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def kill(
        self, process_id: str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._control(process_id, "kill", idempotency_key)

    async def start(
        self, process_id: str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._control(process_id, "start", idempotency_key)

    async def stop(
        self, process_id: str, *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        return await self._control(process_id, "stop", idempotency_key)

    async def _control(
        self,
        process_id: str,
        verb: ControlVerb,
        idempotency_key: str | None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"{self._base()}/{process_id}/{verb}",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def schedule(
        self,
        process_id: str,
        *,
        mode: ScheduleMode,
        blocks: Sequence[dict[str, Any]] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if mode == "scheduled" and (blocks is None or len(blocks) == 0):
            msg = "processes.schedule: `blocks` is required when mode='scheduled'"
            raise ValueError(msg)
        body: dict[str, Any] = {"mode": mode}
        if blocks is not None:
            body["blocks"] = list(blocks)
        resp = await self._client.request(
            f"{self._base()}/{process_id}/schedule",
            method="POST",
            body=body,
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}


__all__ = ["ControlVerb", "ProcessRecord", "Processes", "ScheduleMode"]
