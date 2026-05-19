"""``roost.webhooks`` - subscriptions, probes, and delivery debugging."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class WebhookSubscription:
    id: str
    url: str
    events: list[str]
    description: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    paused: bool = False
    last_delivery_at: str | None = None
    last_delivery_status: str | None = None
    failure_count: int = 0


class Webhooks:
    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def subscribe(
        self,
        site_id: str,
        url: str,
        events: Sequence[str],
        description: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "events": list(events)}
        if description is not None:
            body["description"] = description
        resp = await self._client.request(
            "/api/webhooks",
            method="POST",
            query={"siteId": site_id},
            body=body,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def list(self, site_id: str) -> list[WebhookSubscription]:
        resp = await self._client.request("/api/webhooks", query={"siteId": site_id})
        data = resp.data if isinstance(resp.data, dict) else {}
        return [
            WebhookSubscription(
                id=str(w.get("id", "")),
                url=str(w.get("url", "")),
                events=list(w.get("events") or []),
                description=w.get("description"),
                created_at=w.get("createdAt"),
                updated_at=w.get("updatedAt"),
                paused=bool(w.get("paused", False)),
                last_delivery_at=w.get("lastDeliveryAt"),
                last_delivery_status=w.get("lastDeliveryStatus"),
                failure_count=int(w.get("failureCount") or 0),
            )
            for w in data.get("webhooks", [])
            if isinstance(w, dict)
        ]

    async def get(self, webhook_id: str, site_id: str) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def update(
        self,
        webhook_id: str,
        site_id: str,
        *,
        url: str | None = None,
        events: Sequence[str] | None = None,
        description: str | None = None,
        paused: bool | None = None,
    ) -> dict[str, Any]:
        patch: dict[str, Any] = {}
        if url is not None:
            patch["url"] = url
        if events is not None:
            patch["events"] = list(events)
        if description is not None:
            patch["description"] = description
        if paused is not None:
            patch["paused"] = paused
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}",
            method="PATCH",
            query={"siteId": site_id},
            body=patch,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def remove(self, webhook_id: str, site_id: str) -> None:
        await self._client.request(
            f"/api/webhooks/{webhook_id}",
            method="DELETE",
            query={"siteId": site_id},
        )

    async def rotate_secret(self, webhook_id: str, site_id: str) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}/rotate-secret",
            method="POST",
            query={"siteId": site_id},
            body={},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def deliveries(
        self,
        webhook_id: str,
        site_id: str,
        *,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}/deliveries",
            query={
                "siteId": site_id,
                "page_size": page_size,
                "page_token": page_token,
            },
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def delivery(
        self,
        webhook_id: str,
        delivery_id: str,
        site_id: str,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}/deliveries/{delivery_id}",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def retry_delivery(
        self,
        webhook_id: str,
        delivery_id: str,
        site_id: str,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/webhooks/{webhook_id}/deliveries/{delivery_id}/retry",
            method="POST",
            query={"siteId": site_id},
            body={},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def probe(
        self,
        site_id: str,
        event: str,
        *,
        url: str,
        payload: dict[str, Any] | None = None,
        signing_secret: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"url": url, "event": event}
        if payload is not None:
            body["payload"] = payload
        if signing_secret is not None:
            body["signingSecret"] = signing_secret
        resp = await self._client.request(
            "/api/webhooks/probe",
            method="POST",
            query={"siteId": site_id},
            body=body,
        )
        return resp.data


__all__ = ["WebhookSubscription", "Webhooks"]
