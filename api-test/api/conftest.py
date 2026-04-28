"""
API Integration Test Fixtures

Provides the api_client fixture and cleanup registries for created resources.
"""

import pytest
from typing import Optional
from helpers.api_client import ApiClient


def deployment_path(
    site_id: str,
    deployment_id: Optional[str] = None,
    action: Optional[str] = None,
) -> str:
    path = f"/api/sites/{site_id}/deployments"
    if deployment_id:
        path = f"{path}/{deployment_id}"
    if action:
        path = f"{path}/{action}"
    return path


def idempotency_headers(label: str) -> dict[str, str]:
    import time
    return {"Idempotency-Key": f"api-test-{label}-{time.time_ns()}"}


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
            resp = api_client.get(deployment_path(site_id, did))
            if resp.status_code == 404:
                continue  # Already deleted (e.g. by the test itself)

            if resp.status_code == 200:
                targets = resp.json().get("targets", [])
                # Only cancel targets that are still in-flight
                for t in targets:
                    if t.get("status") not in target_terminal:
                        try:
                            api_client.post(
                                deployment_path(site_id, did, "cancel"),
                                json={},
                                headers=idempotency_headers(f"cleanup-cancel-{did}"),
                            )
                            break
                        except Exception:
                            pass

            # Now delete the deployment record
            resp = api_client.delete(
                deployment_path(site_id, did),
                json={},
                headers=idempotency_headers(f"cleanup-delete-{did}"),
            )
            if resp.status_code == 409:
                log.warning(f"Could not delete deployment {did}: still non-terminal")
        except Exception:
            pass  # Best-effort cleanup
