"""Webhook signature verification — pure logic, no network."""

from __future__ import annotations

import time

from roost import is_signature_valid, sign_body, verify_signature


def test_sign_body_produces_canonical_shape() -> None:
    header = sign_body("hello", "secret", timestamp_seconds=1700000000)
    assert header.startswith("t=1700000000,v1=")
    assert len(header.split("v1=")[1]) == 64  # sha-256 hex


def test_verify_round_trip() -> None:
    now = int(time.time())
    body = '{"event":"version.published"}'
    header = sign_body(body, "secret", timestamp_seconds=now)
    result = verify_signature(header, body, "secret", now=now)
    assert result.ok is True
    assert result.timestamp == now


def test_rejects_missing_header() -> None:
    result = verify_signature(None, "body", "secret")
    assert result.ok is False
    assert result.reason == "missing_header"


def test_rejects_timestamp_out_of_tolerance() -> None:
    # sign 10 min ago
    stale = int(time.time()) - 600
    body = '{"x":1}'
    header = sign_body(body, "secret", timestamp_seconds=stale)
    result = verify_signature(header, body, "secret")
    assert result.ok is False
    assert result.reason == "timestamp_out_of_tolerance"


def test_rejects_bad_signature() -> None:
    now = int(time.time())
    header = sign_body("one body", "secret", timestamp_seconds=now)
    result = verify_signature(header, "different body", "secret", now=now)
    assert result.ok is False
    assert result.reason == "bad_signature"


def test_tolerance_can_be_infinite() -> None:
    ancient = 1
    body = "payload"
    header = sign_body(body, "secret", timestamp_seconds=ancient)
    assert is_signature_valid(header, body, "secret", tolerance_seconds=float("inf"))


def test_rejects_wrong_secret() -> None:
    now = int(time.time())
    header = sign_body("body", "right-secret", timestamp_seconds=now)
    result = verify_signature(header, "body", "wrong-secret", now=now)
    assert result.ok is False
    assert result.reason == "bad_signature"
