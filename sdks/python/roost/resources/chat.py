"""``roost.chat`` — cortex AI chat (wave 3A).

Drives the conversation routes:

  POST   /api/chat/new                       — start a conversation
  GET    /api/chat?siteId=&page_size=&...    — list conversations
  POST   /api/chat/{conversationId}          — append message + stream reply
  PATCH  /api/chat/{conversationId}          — rename
  DELETE /api/chat/{conversationId}          — soft delete

``send()`` is the streaming verb. It returns an async iterator that
yields the text deltas (utf-8 strings) parsed out of the AI-SDK v3
line-prefixed protocol the server emits via
``result.toUIMessageStreamResponse()``:

  ``0:"<json-encoded delta>"\\n`` → text delta
  ``d:{...}\\n``                  → end-of-stream marker (ignored)
  ``3:"<error>"\\n``              → upstream error → ``RuntimeError``

Use it like::

    async for delta in roost.chat.send(conversation_id, "hello"):
        print(delta, end="", flush=True)
"""

from __future__ import annotations

import json as _json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class ConversationSummary:
    conversation_id: str
    title: str | None
    site_id: str
    machine_id: str | None
    owner_uid: str
    created_at: str | None
    updated_at: str | None
    deleted_at: str | None
    message_count: int


def _parse_summary(raw: dict[str, Any]) -> ConversationSummary:
    return ConversationSummary(
        conversation_id=str(raw.get("conversationId", "")),
        title=raw.get("title"),
        site_id=str(raw.get("siteId", "")),
        machine_id=raw.get("machineId"),
        owner_uid=str(raw.get("ownerUid", "")),
        created_at=raw.get("createdAt"),
        updated_at=raw.get("updatedAt"),
        deleted_at=raw.get("deletedAt"),
        message_count=int(raw.get("messageCount") or 0),
    )


class Chat:
    """Cortex AI chat (wave 3A)."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    async def new(
        self,
        *,
        site_id: str,
        machine_id: str | None = None,
        title: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Start a new conversation. Returns ``{conversationId, siteId, …}``."""
        body: dict[str, Any] = {"siteId": site_id}
        if machine_id is not None:
            body["machineId"] = machine_id
        if title is not None:
            body["title"] = title
        resp = await self._client.request(
            "/api/chat/new",
            method="POST",
            body=body,
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def list(
        self,
        *,
        site_id: str,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List conversations on a site. Returns ``{conversations, nextPageToken}``."""
        query: dict[str, Any] = {"siteId": site_id}
        if page_size is not None:
            query["page_size"] = page_size
        if page_token:
            query["page_token"] = page_token
        resp = await self._client.request("/api/chat", query=query)
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        if not isinstance(payload, dict):
            return {"conversations": [], "next_page_token": ""}
        conversations = [
            _parse_summary(c)
            for c in (payload.get("conversations") or [])
            if isinstance(c, dict)
        ]
        return {
            "conversations": conversations,
            "next_page_token": str(payload.get("nextPageToken") or ""),
        }

    def send(
        self,
        conversation_id: str,
        message: str,
        *,
        role: str = "user",
        idempotency_key: str | None = None,
    ) -> AsyncIterator[str]:
        """Send a message and stream the assistant's text deltas.

        Returns an async iterator. Iterate with ``async for`` to consume
        the reply token-by-token::

            async for delta in roost.chat.send(cid, "hi"):
                print(delta, end="", flush=True)

        Raises ``RuntimeError`` if the server emits an AI-SDK ``3:`` error
        frame mid-stream, or ``RoostApiError`` for non-2xx HTTP responses.
        """
        return _SendIterator(
            client=self._client,
            conversation_id=conversation_id,
            message=message,
            role=role,
            idempotency_key=idempotency_key,
        )

    async def rename(
        self,
        conversation_id: str,
        title: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/chat/{conversation_id}",
            method="PATCH",
            body={"title": title},
            idempotency_key=idempotency_key,
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}

    async def delete(
        self,
        conversation_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        # Preserve a resource-specific prefix rather than the core client's
        # generic py-sdk DELETE key.
        idem = idempotency_key or f"py-sdk-chat-delete-{uuid.uuid4()}"
        resp = await self._client.request(
            f"/api/chat/{conversation_id}",
            method="DELETE",
            headers={"Idempotency-Key": idem},
        )
        envelope = resp.data if isinstance(resp.data, dict) else {}
        payload = envelope.get("data") if isinstance(envelope.get("data"), dict) else envelope
        return payload if isinstance(payload, dict) else {}


class _SendIterator:
    """Async iterator over the AI-SDK v3 line-prefixed text deltas.

    Streaming uses ``httpx.AsyncClient.stream()`` so we never buffer the
    whole reply in memory — deltas are surfaced as they arrive over the
    wire. Returned by :meth:`Chat.send`; not constructed directly.
    """

    def __init__(
        self,
        *,
        client: "RoostClient",
        conversation_id: str,
        message: str,
        role: str,
        idempotency_key: str | None,
    ) -> None:
        self._client = client
        self._conversation_id = conversation_id
        self._message = message
        self._role = role
        self._idempotency_key = idempotency_key
        self._iter: AsyncIterator[str] | None = None

    def __aiter__(self) -> "_SendIterator":
        return self

    async def __anext__(self) -> str:
        if self._iter is None:
            self._iter = self._stream().__aiter__()
        return await self._iter.__anext__()

    async def _stream(self) -> AsyncIterator[str]:
        # Build the same URL + headers the core client uses, then call
        # `_http.stream()` directly — `request()` would buffer the full
        # body before returning, which defeats streaming.
        idem = self._idempotency_key or f"py-sdk-chat-send-{uuid.uuid4()}"
        path = f"/api/chat/{self._conversation_id}"
        body = {"role": self._role, "content": self._message}
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": idem,
        }

        async with self._client._http.stream(
            "POST",
            path,
            json=body,
            headers=headers,
        ) as response:
            if response.status_code >= 400:
                from roost.client import RoostApiError

                raw = await response.aread()
                problem: dict[str, Any]
                try:
                    parsed = _json.loads(raw.decode("utf-8")) if raw else {}
                    problem = parsed if isinstance(parsed, dict) else {"detail": str(parsed)}
                except (ValueError, UnicodeDecodeError):
                    problem = {"detail": raw.decode("utf-8", errors="replace")}
                raise RoostApiError(response.status_code, problem)

            pending = ""
            async for chunk in response.aiter_text():
                pending += chunk
                while True:
                    nl = pending.find("\n")
                    if nl < 0:
                        break
                    line = pending[:nl]
                    pending = pending[nl + 1 :]
                    delta = _consume_line(line)
                    if delta is not None:
                        yield delta
            if pending:
                delta = _consume_line(pending)
                if delta is not None:
                    yield delta


def _consume_line(line: str) -> str | None:
    """Parse one AI-SDK line. Returns the text delta or ``None`` for ignored frames.

    Raises ``RuntimeError`` for ``3:`` upstream-error frames so the caller's
    ``async for`` loop bubbles up the failure cleanly.
    """
    if not line:
        return None
    if line.startswith("0:"):
        try:
            parsed = _json.loads(line[2:])
        except ValueError:
            # Drop malformed delta — never crash the stream.
            return None
        return parsed if isinstance(parsed, str) else None
    if line.startswith("3:"):
        # Upstream error frame.
        raw = line[2:]
        try:
            parsed = _json.loads(raw)
            detail = parsed if isinstance(parsed, str) else raw
        except ValueError:
            detail = raw
        msg = f"cortex stream error: {detail}"
        raise RuntimeError(msg)
    # `d:` end markers + any unknown prefix → ignore.
    return None


__all__ = ["Chat", "ConversationSummary"]
