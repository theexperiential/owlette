"""Webhook signature verification workflow.

Pipe a raw webhook body into stdin and set OWLETTE_SIGNATURE plus
OWLETTE_WEBHOOK_SECRET to verify a real delivery. With no signature env,
the script signs the body first so the fixture can run locally.

Required for real deliveries:
    OWLETTE_WEBHOOK_SECRET or ROOST_WEBHOOK_SECRET
    OWLETTE_SIGNATURE or ROOST_SIGNATURE
"""

from __future__ import annotations

import json
import os
import sys

from roost import sign_body, verify_signature


def main() -> int:
    raw = b"" if sys.stdin.isatty() else sys.stdin.buffer.read()
    body = raw or b'{"event":"version.published","roostId":"rst_example"}'
    secret = (
        os.environ.get("OWLETTE_WEBHOOK_SECRET")
        or os.environ.get("ROOST_WEBHOOK_SECRET")
        or "whsec_dev_fixture_do_not_use"
    )
    signature = os.environ.get("OWLETTE_SIGNATURE") or os.environ.get("ROOST_SIGNATURE")
    if not signature:
        signature = sign_body(body, secret)
        print("generated fixture signature")

    tolerance_raw = os.environ.get("OWLETTE_TOLERANCE_SECONDS")
    tolerance_seconds = float(tolerance_raw) if tolerance_raw else 300.0
    result = verify_signature(
        signature,
        body,
        secret,
        tolerance_seconds=tolerance_seconds,
    )
    print(json.dumps({
        "ok": result.ok,
        "reason": result.reason,
        "timestamp": result.timestamp,
    }, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
