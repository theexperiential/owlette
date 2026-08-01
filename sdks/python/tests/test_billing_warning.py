"""Trial-countdown advisory surfacing (billing-system wave 3.3).

The api sets ``X-Owlette-Billing-Warning`` on every response while the
account's free trial is running. The SDK never prints — it hands the value to
the consumer's optional ``on_billing_warning`` callback and nothing else.
Mirrors ``onBillingWarning`` in the node SDK.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import BILLING_WARNING_HEADER, RetryPolicy, RoostClient

WARNING = "trial ends 2026-08-15T00:00:00.000Z; choose a plan to keep API access"


def transport_with(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_callback_receives_the_header_value() -> None:
    seen: list[str] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True}, headers={BILLING_WARNING_HEADER: WARNING})

    async with Roost(
        token="owk_live_x",
        transport=transport_with(handler),
        on_billing_warning=seen.append,
    ) as client:
        await client.http.request("/api/sites")

    assert seen == [WARNING]


@pytest.mark.asyncio
async def test_no_callback_when_header_absent() -> None:
    seen: list[str] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    async with Roost(
        token="owk_live_x",
        transport=transport_with(handler),
        on_billing_warning=seen.append,
    ) as client:
        await client.http.request("/api/sites")

    assert seen == []


@pytest.mark.asyncio
async def test_callback_is_optional() -> None:
    """A client without the hook still works — the SDK prints nothing itself."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True}, headers={BILLING_WARNING_HEADER: WARNING})

    async with Roost(token="owk_live_x", transport=transport_with(handler)) as client:
        response = await client.http.request("/api/sites")

    assert response.status == 200


@pytest.mark.asyncio
async def test_fires_on_an_error_response_too() -> None:
    seen: list[str] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"code": "not_found"},
            headers={BILLING_WARNING_HEADER: WARNING},
        )

    client = RoostClient(
        token="owk_live_x",
        transport=transport_with(handler),
        retry=RetryPolicy(max_attempts=1),
        on_billing_warning=seen.append,
    )
    try:
        with pytest.raises(RoostApiError):
            await client.request("/api/sites")
    finally:
        await client.close()

    assert seen == [WARNING]


@pytest.mark.asyncio
async def test_fires_once_per_response_including_retries() -> None:
    """Documented semantics: no dedupe — consumers that want at-most-once do it."""
    seen: list[str] = []
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        status = 500 if calls["n"] == 1 else 200
        return httpx.Response(
            status,
            json={"ok": status == 200},
            headers={BILLING_WARNING_HEADER: WARNING},
        )

    client = RoostClient(
        token="owk_live_x",
        transport=transport_with(handler),
        retry=RetryPolicy(max_attempts=5, base_delay_s=0.001, max_delay_s=0.005, jitter=0),
        on_billing_warning=seen.append,
    )
    try:
        await client.request("/api/sites")
    finally:
        await client.close()

    assert seen == [WARNING, WARNING]


@pytest.mark.asyncio
async def test_raising_callback_never_fails_the_request() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True}, headers={BILLING_WARNING_HEADER: WARNING})

    def boom(_warning: str) -> None:
        msg = "consumer bug"
        raise RuntimeError(msg)

    async with Roost(
        token="owk_live_x",
        transport=transport_with(handler),
        on_billing_warning=boom,
    ) as client:
        response = await client.http.request("/api/sites")

    assert response.data == {"ok": True}
