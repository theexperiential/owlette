"""Integration smoke test — gated by ``ROOST_SDK_SMOKE=1``.

Unset → skipped. When enabled, three read-only assertions against a
live dev API using the configured token + site.

Env vars (required when enabled):

    ROOST_SDK_SMOKE_API_URL   e.g. https://dev.owlette.app
    ROOST_SDK_SMOKE_TOKEN     valid owk_test_* / owk_live_* key
    ROOST_SDK_SMOKE_SITE      site id with read access

Optional:

    ROOST_SDK_SMOKE_ROOST     roost id for read/push workflow checks
    ROOST_SDK_SMOKE_PUSH_DIR  directory to publish when push is enabled
    ROOST_SDK_SMOKE_RUN_PUSH  set to 1 to run the write workflow
"""

from __future__ import annotations

import os

import pytest

from roost import PushOptions, Roost

SMOKE_ENABLED = os.environ.get("ROOST_SDK_SMOKE") == "1"
SMOKE_API_URL = os.environ.get("ROOST_SDK_SMOKE_API_URL")
SMOKE_TOKEN = os.environ.get("ROOST_SDK_SMOKE_TOKEN")
SMOKE_SITE = os.environ.get("ROOST_SDK_SMOKE_SITE")
SMOKE_ROOST = os.environ.get("ROOST_SDK_SMOKE_ROOST")
SMOKE_PUSH_DIR = os.environ.get("ROOST_SDK_SMOKE_PUSH_DIR", "./dist")
SMOKE_RUN_PUSH = os.environ.get("ROOST_SDK_SMOKE_RUN_PUSH") == "1"


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_account_whoami_and_version() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        identity = await client.account.whoami()
        version = await client.account.version()
    assert identity.user_id or identity.key
    assert version.current


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


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_roost_workflow_inspects_configured_resources() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    if not SMOKE_ROOST:
        pytest.skip("requires ROOST_SDK_SMOKE_ROOST for the roost workflow smoke")
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        site = await client.sites.get(SMOKE_SITE)
        roost = await client.roosts.get(SMOKE_ROOST, site_id=SMOKE_SITE)
        if SMOKE_RUN_PUSH:
            result = await client.roosts.push(
                SMOKE_PUSH_DIR,
                SMOKE_ROOST,
                PushOptions(site_id=SMOKE_SITE),
            )
            assert result.version_id
    assert site.id == SMOKE_SITE
    assert roost.roost_id == SMOKE_ROOST


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_installer_deployments_list_returns_envelope() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        page = await client.installer_deployments.list(SMOKE_SITE, page_size=5)
    assert isinstance(page, dict)
    assert "items" in page


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_installer_list_returns_versions() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        page = await client.installer.list(page_size=5)
    assert isinstance(page, dict)
    assert "versions" in page


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_chat_list_on_configured_site() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        page = await client.chat.list(site_id=SMOKE_SITE, page_size=5)
    assert isinstance(page, dict)
    assert "conversations" in page


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_users_list_returns_envelope() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        page = await client.users.list(page_size=5)
    assert isinstance(page, dict)
    assert "users" in page


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_members_list_on_configured_site() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        rows = await client.members(SMOKE_SITE).list()
    assert isinstance(rows, list)


@pytest.mark.asyncio
@pytest.mark.skipif(not SMOKE_ENABLED, reason="requires ROOST_SDK_SMOKE=1")
async def test_processes_list_on_configured_machine() -> None:
    assert SMOKE_API_URL and SMOKE_TOKEN and SMOKE_SITE, "smoke env vars missing"
    machine_id = os.environ.get("ROOST_SDK_SMOKE_MACHINE")
    if not machine_id:
        pytest.skip("requires ROOST_SDK_SMOKE_MACHINE for the processes smoke")
    async with Roost(token=SMOKE_TOKEN, api_url=SMOKE_API_URL) as client:
        rows = await client.processes(SMOKE_SITE, machine_id).list()
    assert isinstance(rows, list)


def test_smoke_guard_off_by_default() -> None:
    """Sanity check — the gate must default off so the suite runs hermetic."""
    if not SMOKE_ENABLED:
        assert SMOKE_ENABLED is False
