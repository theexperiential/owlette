"""
API Integration Test Fixtures

Provides the api_client fixture and cleanup registries for created resources.
"""

import pytest
from helpers.api_client import ApiClient


@pytest.fixture(scope="session")
def api_client(auth_session, api_url) -> ApiClient:
    """Authenticated API client with base URL prefix."""
    return ApiClient(auth_session, api_url)


@pytest.fixture
def process_cleanup(api_client, site_id, machine_id):
    """Cleanup registry for processes created during tests.

    Append process IDs to this list; they'll be deleted in teardown.
    """
    created_ids = []
    yield created_ids
    for pid in reversed(created_ids):
        try:
            api_client.delete(
                f"/api/admin/processes/{pid}",
                params={"siteId": site_id, "machineId": machine_id},
            )
        except Exception:
            pass  # Best-effort cleanup


@pytest.fixture
def deployment_cleanup(api_client, site_id):
    """Cleanup registry for deployments created during tests.

    Append deployment IDs to this list; they'll be deleted in teardown.
    """
    created_ids = []
    yield created_ids
    for did in reversed(created_ids):
        try:
            api_client.delete(
                f"/api/admin/deployments/{did}",
                params={"siteId": site_id},
            )
        except Exception:
            pass  # Best-effort cleanup
