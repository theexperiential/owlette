"""``roost.quotas`` — current usage + daily history."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class QuotaSnapshot:
    site_id: str
    tier: str
    used_bytes: int
    pending_bytes: int
    committed_bytes: int
    limit_bytes: int | None
    fraction_used: float | None
    unlimited: bool
    last_alarm_level: int
    last_alarm_at: str | None
    last_reconciled_at: str | None
    alarms: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class QuotaHistoryDay:
    date: str
    storage_bytes_avg: int | None
    class_a_ops: int
    class_b_ops: int
    egress_bytes: int


class Quotas:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def current(self, site_id: str) -> QuotaSnapshot:
        resp = await self._client.request(f"/api/sites/{site_id}/quota")
        data = resp.data if isinstance(resp.data, dict) else {}
        return QuotaSnapshot(
            site_id=str(data.get("siteId", site_id)),
            tier=str(data.get("tier", "free")),
            used_bytes=int(data.get("usedBytes") or 0),
            pending_bytes=int(data.get("pendingBytes") or 0),
            committed_bytes=int(data.get("committedBytes") or 0),
            limit_bytes=data.get("limitBytes"),
            fraction_used=data.get("fractionUsed"),
            unlimited=bool(data.get("unlimited", False)),
            last_alarm_level=int(data.get("lastAlarmLevel") or 0),
            last_alarm_at=data.get("lastAlarmAt"),
            last_reconciled_at=data.get("lastReconciledAt"),
            alarms=list(data.get("alarms") or []),
        )

    async def history(
        self,
        site_id: str,
        period: Literal["7d", "14d", "30d", "60d", "90d"] = "30d",
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/sites/{site_id}/quota/history",
            query={"period": period},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["QuotaHistoryDay", "QuotaSnapshot", "Quotas"]
