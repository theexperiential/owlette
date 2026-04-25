"""auto-rollback on `deployment.failed` webhook.

Mirrors docs/api/examples/auto-rollback.md. Runs as an aiohttp server that
verifies the ``Roost-Signature`` hmac, calls rollback for the offending
roost, and pings slack. Deploy behind nginx / cloudflare / a reverse proxy
that terminates TLS.

Required env vars::

    ROOST_TOKEN            — roost:<id>:rollback scope
    ROOST_SIGNING_SECRET   — whsec_* returned by webhooks.subscribe()
    SLACK_WEBHOOK_URL      — slack incoming webhook
    AUTO_ROLLBACK_SITE_IDS — comma-separated allowlist

Install the extra dep::

    pip install aiohttp
"""

from __future__ import annotations

import json
import os
import sys

import httpx
from aiohttp import web

from roost import RollbackOptions, Roost, RoostApiError, verify_signature


def _require_env(*names: str) -> None:
    for name in names:
        if not os.environ.get(name):
            print(f"fatal: missing env var {name}", file=sys.stderr)
            sys.exit(1)


_require_env(
    "ROOST_TOKEN", "ROOST_SIGNING_SECRET",
    "SLACK_WEBHOOK_URL", "AUTO_ROLLBACK_SITE_IDS",
)

TOKEN = os.environ["ROOST_TOKEN"]
SECRET = os.environ["ROOST_SIGNING_SECRET"]
SLACK_URL = os.environ["SLACK_WEBHOOK_URL"]
ALLOWED_SITES = {s.strip() for s in os.environ["AUTO_ROLLBACK_SITE_IDS"].split(",") if s.strip()}
API_URL = os.environ.get("ROOST_BASE", "https://owlette.app")
PORT = int(os.environ.get("PORT", "8080"))


async def slack(text: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            await http.post(SLACK_URL, json={"text": text})
    except Exception:
        pass


async def handle_webhook(request: web.Request) -> web.Response:
    raw = await request.read()
    sig = request.headers.get("Roost-Signature")
    verdict = verify_signature(sig, raw, secret=SECRET)
    if not verdict.ok:
        print(f"[auto-rollback] rejected {verdict.reason}", file=sys.stderr)
        return web.Response(status=401, text=verdict.reason or "bad_signature")

    payload = json.loads(raw.decode("utf-8"))
    if payload.get("type") != "deployment.failed":
        return web.Response(status=204)

    data = payload.get("data") or {}
    site_id = data.get("siteId")
    roost_id = data.get("roostId")
    failed = data.get("failedVersionId")

    if not site_id or not roost_id or site_id not in ALLOWED_SITES:
        print(f"[auto-rollback] skipped site={site_id} roost={roost_id} (not in allowlist)")
        return web.Response(status=204)

    async with Roost(token=TOKEN, api_url=API_URL) as client:
        try:
            result = await client.roosts.rollback(roost_id, RollbackOptions(site_id=site_id))
            print(f"[auto-rollback] ok roost={roost_id} reverted {failed} → {result.current_version_id}")
            await slack(f":rewind: auto-rollback fired for *{roost_id}* on *{site_id}* — reverted `{failed}` → `{result.current_version_id}`")
            return web.json_response({"ok": True})
        except RoostApiError as err:
            detail = f"{err.status} {err.code}"
            print(f"[auto-rollback] rollback failed roost={roost_id}: {detail}", file=sys.stderr)
            await slack(f":rotating_light: auto-rollback FAILED for *{roost_id}* — {detail}")
            return web.Response(status=502, text="rollback failed")


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/webhooks/roost", handle_webhook)
    return app


if __name__ == "__main__":
    print(f"[auto-rollback] listening on :{PORT}")
    web.run_app(build_app(), port=PORT, print=None)
