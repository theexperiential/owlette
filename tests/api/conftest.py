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


@pytest.fixture(scope="class")
def deployment_cleanup(api_client, site_id, machine_id):
    """Cleanup registry for deployments created during tests.

    Append (deployment_id, machine_ids) tuples to this list.
    Teardown cancels all non-terminal targets first, then deletes.
    """
    created: list[tuple[str, list[str]]] = []
    yield created
    for did, machine_ids in reversed(created):
        try:
            # Cancel all targets so the deployment reaches a terminal state.
            # Without this, DELETE returns 409 and the deployment is orphaned.
            for mid in machine_ids:
                try:
                    api_client.post(
                        f"/api/admin/deployments/{did}/cancel",
                        json={
                            "siteId": site_id,
                            "machineId": mid,
                            "installer_name": "__cleanup__",
                        },
                    )
                except Exception:
                    pass

            # Now delete — deployment should be in a terminal state
            resp = api_client.delete(
                f"/api/admin/deployments/{did}",
                params={"siteId": site_id},
            )
            # If still non-terminal (race condition), log but don't fail
            if resp.status_code == 409:
                import logging
                logging.getLogger(__name__).warning(
                    f"Could not delete deployment {did}: still non-terminal"
                )
        except Exception:
            pass  # Best-effort cleanup
