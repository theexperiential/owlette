"""nightly directory sync — publish only when content changed.

Mirrors docs/api/examples/nightly-sync.md. ``push()`` is content-addressed
end-to-end, so when nothing has changed every chunk hash already exists in
r2, ``stats.uploaded_chunks == 0``, and the server returns the existing
version id without writing a new one. This script reports that cleanly.

Run from cron / systemd::

    0 3 * * *  python /opt/roost/nightly_sync.py

Required env vars::

    ROOST_TOKEN, ROOST_SITE_ID, ROOST_ID, WATCH_DIR

Optional::

    ALERT_WEBHOOK — slack incoming webhook for quota alerts
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx

from roost import PushOptions, Roost, RoostApiError


async def alert(webhook: str | None, text: str) -> None:
    if not webhook:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            await http.post(webhook, json={"text": text})
    except Exception:
        pass


async def main() -> int:
    token = os.environ.get("ROOST_TOKEN")
    site_id = os.environ.get("ROOST_SITE_ID")
    roost_id = os.environ.get("ROOST_ID")
    watch_dir = os.environ.get("WATCH_DIR")
    api_url = os.environ.get("ROOST_BASE", "https://owlette.app")
    alert_webhook = os.environ.get("ALERT_WEBHOOK")

    for name, val in [
        ("ROOST_TOKEN", token), ("ROOST_SITE_ID", site_id),
        ("ROOST_ID", roost_id), ("WATCH_DIR", watch_dir),
    ]:
        if not val:
            print(f"fatal: missing env var {name}", file=sys.stderr)
            return 1

    assert token and site_id and roost_id and watch_dir

    async with Roost(token=token, api_url=api_url) as client:
        try:
            before = await client.roosts.get(roost_id, site_id=site_id)
            previous = before.current_version.version_id if before.current_version else None

            result = await client.roosts.push(
                watch_dir, roost_id, PushOptions(site_id=site_id),
            )

            if result.version_id == previous:
                print(json.dumps({"level": "info", "msg": "no-op — nothing changed", "versionId": result.version_id}))
                return 0

            print(json.dumps({
                "level": "info",
                "msg": "published new version",
                "versionId": result.version_id,
                "versionNumber": result.version_number,
                "previousVersionId": previous,
                "uploadedChunks": result.stats.uploaded_chunks,
                "totalBytes": result.stats.total_bytes,
            }))
            return 0
        except RoostApiError as err:
            if err.code == "quota_exceeded":
                await alert(alert_webhook, f"roost nightly-sync: quota exceeded for site {site_id}")
                print(json.dumps({"level": "error", "code": "quota_exceeded", "requestId": err.request_id}), file=sys.stderr)
                return 2
            print(json.dumps({"level": "error", "msg": str(err)}), file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
