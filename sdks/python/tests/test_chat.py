"""Tests for ``roost.chat`` (wave 3A)."""

from __future__ import annotations

import json

import httpx
import pytest

from roost import Roost, RoostApiError
from roost.client import RetryPolicy


def _transport(handler: "callable[[httpx.Request], httpx.Response]") -> httpx.MockTransport:
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_new_sends_idempotency_key_and_returns_payload() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {"conversationId": "c1", "siteId": "s1", "title": "demo"},
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        result = await client.chat.new(site_id="s1", title="demo")

    assert result["conversationId"] == "c1"
    req = captured[0]
    assert req.url.path == "/api/cortex/conversations"
    assert req.method == "POST"
    body = json.loads(req.content)
    assert body == {"siteId": "s1", "title": "demo"}
    assert req.headers["Idempotency-Key"].startswith("py-sdk-")


@pytest.mark.asyncio
async def test_list_parses_conversation_summaries() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "conversations": [
                        {
                            "conversationId": "c1",
                            "title": "hi",
                            "siteId": "s1",
                            "ownerUid": "u1",
                            "createdAt": "2026-04-25T00:00:00Z",
                            "updatedAt": "2026-04-25T00:01:00Z",
                            "messageCount": 4,
                        }
                    ],
                    "nextPageToken": "tok2",
                },
            },
        )

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        page = await client.chat.list(site_id="s1", page_size=5)

    assert page["next_page_token"] == "tok2"
    assert len(page["conversations"]) == 1
    c = page["conversations"][0]
    assert c.conversation_id == "c1"
    assert c.message_count == 4


@pytest.mark.asyncio
async def test_send_streams_text_deltas_in_order() -> None:
    # AI-SDK v3 line-prefixed protocol — text deltas are `0:"<json>"\n`,
    # `d:` end markers are ignored.
    body = (
        b'0:"hello "\n'
        b'0:"world"\n'
        b'd:{"finishReason":"stop"}\n'
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/plain"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        deltas: list[str] = []
        async for d in client.chat.send("c1", "hi"):
            deltas.append(d)

    assert deltas == ["hello ", "world"]


@pytest.mark.asyncio
async def test_send_raises_on_upstream_error_frame() -> None:
    body = b'0:"partial "\n3:"rate limit"\n'

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/plain"})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        deltas: list[str] = []
        with pytest.raises(RuntimeError, match="rate limit"):
            async for d in client.chat.send("c1", "hi"):
                deltas.append(d)
        # The first delta still made it through before the error.
        assert deltas == ["partial "]


@pytest.mark.asyncio
async def test_send_raises_roost_api_error_on_non_2xx() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={"code": "scope_insufficient", "detail": "no chat scope"},
        )

    async with Roost(
        token="owk_live_x",
        transport=_transport(handler),
        retry=RetryPolicy(max_attempts=1),
    ) as client:
        with pytest.raises(RoostApiError) as excinfo:
            async for _ in client.chat.send("c1", "hi"):
                pass
        assert excinfo.value.status == 403
        assert excinfo.value.code == "scope_insufficient"


@pytest.mark.asyncio
async def test_rename_and_delete_emit_correct_methods() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.method == "PATCH":
            return httpx.Response(200, json={"ok": True, "data": {"title": "new"}})
        return httpx.Response(200, json={"ok": True, "data": {"alreadyDeleted": False}})

    async with Roost(token="owk_live_x", transport=_transport(handler)) as client:
        await client.chat.rename("c1", "new")
        await client.chat.delete("c1")

    assert captured[0].method == "PATCH"
    assert captured[0].url.path == "/api/cortex/conversations/c1"
    assert captured[1].method == "DELETE"
    assert captured[1].url.path == "/api/cortex/conversations/c1"
    # Chat uses a resource-specific prefix even though the core client can
    # also auto-add idempotency keys on DELETE.
    assert captured[1].headers["Idempotency-Key"].startswith("py-sdk-chat-delete-")
