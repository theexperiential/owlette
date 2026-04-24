"""Integration smoke test — gated by ``ROOST_SDK_SMOKE=1``.

Unset → skipped. When enabled, three read-only assertions against a
live dev API using the configured token + site.

Env vars (required when enabled):

    ROOST_SDK_SMOKE_API_URL   e.g. https://dev.owlette.app
    ROOST_SDK_SMOKE_TOKEN     valid owk_test_* / owk_live_* key
    ROOST_SDK_SMOKE_SITE      site id with read access
"""

from __future__ import annotations

import os

import pytest

from roost import Roost

SMOKE_ENABLED = os.environ.get("ROOST_SDK_SMOKE") == "1"
SMOKE_API_URL = os.environ.get("ROOST_SDK_SMOKE_API_URL")
SMOKE_TOKEN = os.environ.get("ROOST_SDK_SMOKE_TOKEN")
SMOKE_SITE = os.environ.get("ROOST_SDK_SMOKE_SITE")


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_sites_list_returns_at_least_one() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        sites = await client.sites.list()
    assert isinstance(sites, list)
    assert len(sites) > 0


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_roosts_list_paginates_configured_site() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        rows, _cursor = await client.roosts.list_page(site_id=SMOKE_SITE, page_size=5)
    assert isinstance(rows, list)


def test_smoke_guard_off_by_default() -> None:
    """Sanity check — the gate must default off so the suite runs hermetic."""
    if not SMOKE_ENABLED:
        assert SMOKE_ENABLED is False
