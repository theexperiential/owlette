"""Low-level async HTTP client + typed error envelope for the roost SDK.

Mirrors `sdks/node/src/lib/client.ts` so users reading between both SDKs
see the same concepts (retry on 429+5xx only, auto-idempotency-key on
POST/PATCH/PUT/DELETE calls, problem+json → typed exception).
"""

from __future__ import annotations

import asyncio
import random
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

import httpx

from roost._version import SDK_VERSION

if TYPE_CHECKING:
    from types import TracebackType

DEFAULT_API_URL = "https://owlette.app"
DEFAULT_ROOST_VERSION = "2026-04-22"

Environment = Literal["live", "test"]
HttpMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]


@dataclass(slots=True)
class RetryPolicy:
    """Retry driver — 5 attempts, exponential backoff, ±jitter, honors Retry-After."""

    max_attempts: int = 5
    base_delay_s: float = 0.25
    max_delay_s: float = 8.0
    jitter: float = 0.25

    def delay_for(self, attempt: int, error: RoostApiError | None) -> float:
        """Delay before the next attempt (seconds)."""
        if error is not None and error.status == 429:
            retry_after = error.problem.get("retryAfter")
            if isinstance(retry_after, int | float) and retry_after > 0:
                return min(float(retry_after), self.max_delay_s * 2)
        expo = min(self.max_delay_s, self.base_delay_s * (2**attempt))
        jitter_factor = 1 + (random.random() * 2 - 1) * self.jitter
        return max(0.0, expo * jitter_factor)


class RoostApiError(Exception):
    """Raised for any non-2xx response. `.status`, `.code`, `.problem`, `.request_id` expose the details."""

    def __init__(self, status: int, problem: dict[str, Any]) -> None:
        self.status = status
        self.problem = problem
        self.code: str | None = problem.get("code") if isinstance(problem.get("code"), str) else None
        self.request_id: str | None = (
            problem.get("requestId") if isinstance(problem.get("requestId"), str) else None
        )
        detail = problem.get("detail")
        title = problem.get("title") or f"http {status}"
        super().__init__(detail if isinstance(detail, str) else title)

    def __repr__(self) -> str:
        return f"RoostApiError(status={self.status}, code={self.code!r}, request_id={self.request_id!r})"


def _should_retry(error: Exception) -> bool:
    if isinstance(error, RoostApiError):
        return error.status == 429 or error.status >= 500
    # httpx transport-level errors (timeouts, connection resets, etc.)
    return isinstance(error, httpx.TransportError)


@dataclass(slots=True)
class ApiResponse:
    """Parsed response payload — same shape as the node sdk's `ApiResponse<T>`."""

    status: int
    data: Any
    headers: dict[str, str] = field(default_factory=dict)


class RoostClient:
    """Async HTTP primitive. Every resource class in this SDK holds one instance."""

    def __init__(
        self,
        *,
        token: str,
        api_url: str = DEFAULT_API_URL,
        roost_version: str = DEFAULT_ROOST_VERSION,
        environment: Environment | None = None,
        retry: RetryPolicy | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not token or not isinstance(token, str):
            msg = "RoostClient: `token` is required"
            raise ValueError(msg)
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.roost_version = roost_version
        self.environment: Environment | None = environment
        self.retry = retry or RetryPolicy()
        client_args: dict[str, Any] = {
            "base_url": self.api_url,
            "timeout": timeout,
            "headers": {
                "Authorization": f"Bearer {self.token}",
                "Roost-Version": self.roost_version,
                "User-Agent": f"owlette-sdk-python/{SDK_VERSION}",
                "Accept": "application/json",
            },
        }
        if transport is not None:
            client_args["transport"] = transport
        self._http: httpx.AsyncClient = httpx.AsyncClient(**client_args)

    async def __aenter__(self) -> "RoostClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: "TracebackType | None",
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Release the underlying httpx.AsyncClient. Idempotent."""
        await self._http.aclose()

    async def request(
        self,
        path: str,
        *,
        method: HttpMethod = "GET",
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
        no_retry: bool = False,
    ) -> ApiResponse:
        """Issue an authed request. Retries transient failures per `self.retry`."""

        # Drop None values from query so optional args render as "unset" not "None".
        clean_query = {k: _coerce_query(v) for k, v in (query or {}).items() if v is not None}

        request_headers = dict(headers or {})
        is_mutating = method in ("POST", "PATCH", "PUT", "DELETE")
        if is_mutating and idempotency_key != "" and "Idempotency-Key" not in request_headers:
            request_headers["Idempotency-Key"] = idempotency_key or f"py-sdk-{uuid.uuid4()}"

        async def run_once() -> ApiResponse:
            kwargs: dict[str, Any] = {}
            if clean_query:
                kwargs["params"] = clean_query
            if request_headers:
                kwargs["headers"] = request_headers
            if body is not None:
                kwargs["json"] = body
            response = await self._http.request(method, path, **kwargs)
            parsed: Any = None
            if response.content:
                content_type = response.headers.get("content-type", "")
                if "json" in content_type or response.content.startswith((b"{", b"[")):
                    try:
                        parsed = response.json()
                    except ValueError:
                        parsed = response.text
                else:
                    parsed = response.text

            if response.status_code >= 400:
                problem = parsed if isinstance(parsed, dict) else {"detail": str(parsed or "")}
                raise RoostApiError(response.status_code, problem)

            return ApiResponse(
                status=response.status_code,
                data=parsed,
                headers=dict(response.headers),
            )

        if no_retry:
            return await run_once()

        last_error: Exception | None = None
        for attempt in range(self.retry.max_attempts):
            try:
                return await run_once()
            except Exception as err:  # noqa: BLE001 — caller wants transport errors too
                last_error = err
                if attempt == self.retry.max_attempts - 1 or not _should_retry(err):
                    raise
                api_err = err if isinstance(err, RoostApiError) else None
                await asyncio.sleep(self.retry.delay_for(attempt, api_err))
        assert last_error is not None
        raise last_error


def _coerce_query(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


__all__ = [
    "DEFAULT_API_URL",
    "DEFAULT_ROOST_VERSION",
    "SDK_VERSION",
    "ApiResponse",
    "Environment",
    "RetryPolicy",
    "RoostApiError",
    "RoostClient",
]
