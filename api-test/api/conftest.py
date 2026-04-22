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
    Teardown checks each target's status — only cancels non-terminal targets,
    leaves completed/failed ones alone — then deletes the deployment record.
    """
    import logging
    log = logging.getLogger(__name__)

    created: list[tuple[str, list[str]]] = []
    yield created

    target_terminal = {"completed", "failed", "cancelled", "uninstalled"}

    for did, machine_ids in reversed(created):
        try:
            # Check current deployment state before touching it
            resp = api_client.get(
                f"/api/admin/deployments/{did}",
                params={"siteId": site_id},
            )
            if resp.status_code == 404:
                continue  # Already deleted (e.g. by the test itself)

            if resp.status_code == 200:
                targets = resp.json().get("deployment", {}).get("targets", [])
                # Only cancel targets that are still in-flight
                for t in targets:
                    if t.get("status") not in target_terminal:
                        try:
                            api_client.post(
                                f"/api/admin/deployments/{did}/cancel",
                                json={
                                    "siteId": site_id,
                                    "machineId": t["machineId"],
                                    "installer_name": "__cleanup__",
                                },
                            )
                        except Exception:
                            pass

            # Now delete the deployment record
            resp = api_client.delete(
                f"/api/admin/deployments/{did}",
                params={"siteId": site_id},
            )
            if resp.status_code == 409:
                log.warning(f"Could not delete deployment {did}: still non-terminal")
        except Exception:
            pass  # Best-effort cleanup
