"""Webhook signature verification — matches the server dispatcher at
``functions/src/webhookDispatch.ts`` and the node SDK's ``signature.ts``.

Format: ``Roost-Signature: t=<unix>,v1=<hmac-sha256-hex>``
Signed payload: ``f"{t}.{raw_body}"`` (raw bytes — reserialization breaks the hash).
"""

from __future__ import annotations

import hmac
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal

DEFAULT_REPLAY_TOLERANCE_SECONDS = 5 * 60

VerifyReason = Literal[
    "missing_header",
    "malformed_header",
    "missing_timestamp",
    "missing_v1",
    "timestamp_out_of_tolerance",
    "bad_signature",
]


@dataclass(slots=True)
class VerifySignatureResult:
    ok: bool
    reason: VerifyReason | None = None
    timestamp: int | None = None


def verify_signature(
    header: str | None,
    body: str | bytes,
    secret: str,
    *,
    tolerance_seconds: float = DEFAULT_REPLAY_TOLERANCE_SECONDS,
    now: float | None = None,
) -> VerifySignatureResult:
    """Verify a stripe-style ``Roost-Signature`` header over ``body``."""
    if not header:
        return VerifySignatureResult(ok=False, reason="missing_header")

    timestamp: int | None = None
    v1_values: list[str] = []
    for part in (p.strip() for p in header.split(",") if p.strip()):
        eq = part.find("=")
        if eq <= 0:
            continue
        key, value = part[:eq], part[eq + 1 :]
        if key == "t":
            try:
                num = int(value)
            except ValueError:
                continue
            if num > 0:
                timestamp = num
        elif key == "v1":
            v1_values.append(value)

    if timestamp is None:
        return VerifySignatureResult(ok=False, reason="missing_timestamp")
    if not v1_values:
        return VerifySignatureResult(ok=False, reason="missing_v1", timestamp=timestamp)

    if tolerance_seconds != float("inf"):
        current = now if now is not None else time.time()
        if abs(current - timestamp) > tolerance_seconds:
            return VerifySignatureResult(ok=False, reason="timestamp_out_of_tolerance", timestamp=timestamp)

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode() + body_bytes,
        sha256,
    ).digest()

    for sig in v1_values:
        try:
            candidate = bytes.fromhex(sig)
        except ValueError:
            continue
        if len(candidate) != len(expected):
            continue
        if hmac.compare_digest(candidate, expected):
            return VerifySignatureResult(ok=True, timestamp=timestamp)

    return VerifySignatureResult(ok=False, reason="bad_signature", timestamp=timestamp)


def is_signature_valid(
    header: str | None,
    body: str | bytes,
    secret: str,
    *,
    tolerance_seconds: float = DEFAULT_REPLAY_TOLERANCE_SECONDS,
    now: float | None = None,
) -> bool:
    """Thin boolean wrapper — discards the reason when you don't need it."""
    return verify_signature(
        header, body, secret, tolerance_seconds=tolerance_seconds, now=now
    ).ok


def sign_body(
    body: str | bytes,
    secret: str,
    *,
    timestamp_seconds: int | None = None,
) -> str:
    """Produce a canonical ``t=…,v1=…`` header. Useful for client-side test fixtures."""
    t = timestamp_seconds if timestamp_seconds is not None else int(time.time())
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    sig = hmac.new(
        secret.encode("utf-8"),
        f"{t}.".encode() + body_bytes,
        sha256,
    ).hexdigest()
    return f"t={t},v1={sig}"


__all__ = [
    "DEFAULT_REPLAY_TOLERANCE_SECONDS",
    "VerifyReason",
    "VerifySignatureResult",
    "is_signature_valid",
    "sign_body",
    "verify_signature",
]
