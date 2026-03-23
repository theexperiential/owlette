"""
Deployment Integration Tests

Lifecycle: create → list → detail → cancel → delete.
Validation tests for error cases.
"""

import pytest


@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestDeploymentLifecycle:
    """Full deployment lifecycle tests."""

    deployment_id = None

    def test_01_create_deployment(self, api_client, site_id, machine_id, deployment_cleanup):
        """POST creates a deployment with target machines."""
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "Integration Test Deployment",
            "installer_name": "TestInstaller.exe",
            "installer_url": "https://example.com/test-installer.exe",
            "silent_flags": "/VERYSILENT",
            "machineIds": [machine_id],
        })
        assert resp.status_code == 200, f"Create failed: {resp.text}"
        data = resp.json()
        assert data["success"] is True
        assert "deploymentId" in data
        TestDeploymentLifecycle.deployment_id = data["deploymentId"]
        deployment_cleanup.append(data["deploymentId"])

    def test_02_list_deployments(self, api_client, site_id):
        """GET lists deployments including the created one."""
        assert TestDeploymentLifecycle.deployment_id is not None
        resp = api_client.get("/api/admin/deployments", params={"siteId": site_id})
        assert resp.status_code == 200
        deployments = resp.json()["deployments"]
        ids = [d["id"] for d in deployments]
        assert TestDeploymentLifecycle.deployment_id in ids

    def test_03_get_deployment_detail(self, api_client, site_id):
        """GET /{id} returns full deployment with targets."""
        assert TestDeploymentLifecycle.deployment_id is not None
        resp = api_client.get(
            f"/api/admin/deployments/{TestDeploymentLifecycle.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200
        deployment = resp.json()["deployment"]
        assert deployment["id"] == TestDeploymentLifecycle.deployment_id
        assert len(deployment["targets"]) >= 1

    def test_04_cancel_deployment(self, api_client, site_id, machine_id):
        """POST cancel for a specific machine target."""
        assert TestDeploymentLifecycle.deployment_id is not None
        resp = api_client.post(
            f"/api/admin/deployments/{TestDeploymentLifecycle.deployment_id}/cancel",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "installer_name": "TestInstaller.exe",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_05_verify_cancelled_status(self, api_client, site_id, machine_id):
        """GET detail shows cancelled target status."""
        assert TestDeploymentLifecycle.deployment_id is not None
        resp = api_client.get(
            f"/api/admin/deployments/{TestDeploymentLifecycle.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200
        deployment = resp.json()["deployment"]
        target = next(
            (t for t in deployment["targets"] if t["machineId"] == machine_id),
            None,
        )
        assert target is not None
        assert target["status"] == "cancelled"


@pytest.mark.api
@pytest.mark.integration
class TestDeploymentValidation:
    """Tests for deployment validation errors."""

    def test_create_missing_fields(self, api_client, site_id):
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "Test",
            # Missing installer_name, installer_url, silent_flags, machineIds
        })
        assert resp.status_code == 400

    def test_create_empty_machine_ids(self, api_client, site_id):
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "Test",
            "installer_name": "test.exe",
            "installer_url": "https://example.com/test.exe",
            "silent_flags": "/S",
            "machineIds": [],
        })
        assert resp.status_code == 400

    def test_get_nonexistent_deployment(self, api_client, site_id):
        resp = api_client.get(
            "/api/admin/deployments/deploy-nonexistent-99999",
            params={"siteId": site_id},
        )
        assert resp.status_code == 404

    def test_delete_missing_site_id(self, api_client):
        resp = api_client.delete("/api/admin/deployments/deploy-123")
        assert resp.status_code == 400
