"""
Deployment Integration Tests

Tests the full deployment API lifecycle using real-world installer URLs
representing common installer types (NSIS, Inno Setup, MSI-wrapped EXE, etc.).

Lifecycle: create → list → detail → cancel → verify-cancelled → delete.
Validation tests for error cases.
"""

import pytest


# ---------------------------------------------------------------------------
#  Real-world installer test data
#
#  Each entry represents a common installer type that Owlette deployments
#  would handle in production. URLs point to genuine public releases.
# ---------------------------------------------------------------------------
INSTALLERS = {
    "nsis": {
        "name": "7-Zip (NSIS)",
        "installer_name": "7z2408-x64.exe",
        "installer_url": "https://www.7-zip.org/a/7z2408-x64.exe",
        "silent_flags": "/S",
        "verify_path": "C:/Program Files/7-Zip/7z.exe",
    },
    "inno_setup": {
        "name": "VLC Media Player (Inno Setup)",
        "installer_name": "vlc-3.0.21-win64.exe",
        "installer_url": "https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe",
        "silent_flags": "/VERYSILENT /NORESTART",
        "verify_path": "C:/Program Files/VideoLAN/VLC/vlc.exe",
    },
    "msi": {
        "name": "Git for Windows (Inno Setup / MSI)",
        "installer_name": "Git-2.47.1-64-bit.exe",
        "installer_url": "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe",
        "silent_flags": "/VERYSILENT /NORESTART /SP-",
        "verify_path": "C:/Program Files/Git/cmd/git.exe",
    },
    "portable_exe": {
        "name": "Notepad++ (NSIS)",
        "installer_name": "npp.8.7.1.Installer.x64.exe",
        "installer_url": "https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.7.1/npp.8.7.1.Installer.x64.exe",
        "silent_flags": "/S",
        "verify_path": "C:/Program Files/Notepad++/notepad++.exe",
    },
    "msi_native": {
        "name": "Python 3.12 (MSI)",
        "installer_name": "python-3.12.8-amd64.exe",
        "installer_url": "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe",
        "silent_flags": "/quiet InstallAllUsers=1 PrependPath=1",
        "verify_path": "C:/Program Files/Python312/python.exe",
    },
}


@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestDeploymentLifecycle:
    """Full deployment lifecycle: create → list → detail → cancel → delete.

    Uses a real NSIS installer URL (7-Zip) to validate the complete flow.
    The cleanup fixture ensures the deployment is removed even if a test fails.
    """

    deployment_id: str | None = None

    def test_01_create_deployment(self, api_client, site_id, machine_id, deployment_cleanup):
        """POST creates a deployment with correct structure."""
        installer = INSTALLERS["nsis"]
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": installer["name"],
            "installer_name": installer["installer_name"],
            "installer_url": installer["installer_url"],
            "silent_flags": installer["silent_flags"],
            "verify_path": installer["verify_path"],
            "machineIds": [machine_id],
        })
        assert resp.status_code == 200, f"Create failed: {resp.text}"

        data = resp.json()
        assert data["success"] is True
        assert data["deploymentId"].startswith("deploy-")

        TestDeploymentLifecycle.deployment_id = data["deploymentId"]
        deployment_cleanup.append((data["deploymentId"], [machine_id]))

    def test_02_list_deployments(self, api_client, site_id):
        """GET lists deployments and includes the one we just created."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.get("/api/admin/deployments", params={"siteId": site_id})
        assert resp.status_code == 200

        data = resp.json()
        assert data["success"] is True
        ids = [d["id"] for d in data["deployments"]]
        assert self.deployment_id in ids

        # Verify the deployment data matches what we created
        deployment = next(d for d in data["deployments"] if d["id"] == self.deployment_id)
        assert deployment["installer_name"] == INSTALLERS["nsis"]["installer_name"]
        assert deployment["status"] in ("pending", "in_progress")

    def test_03_get_deployment_detail(self, api_client, site_id, machine_id):
        """GET /{id} returns full deployment with targets array."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.get(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200

        deployment = resp.json()["deployment"]
        assert deployment["id"] == self.deployment_id
        assert deployment["name"] == INSTALLERS["nsis"]["name"]
        assert deployment["installer_url"] == INSTALLERS["nsis"]["installer_url"]
        assert deployment["verify_path"] == INSTALLERS["nsis"]["verify_path"]
        assert len(deployment["targets"]) == 1
        assert deployment["targets"][0]["machineId"] == machine_id

    def test_04_cancel_deployment(self, api_client, site_id, machine_id):
        """POST cancel sends cancel command and marks target as cancelled."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.post(
            f"/api/admin/deployments/{self.deployment_id}/cancel",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "installer_name": INSTALLERS["nsis"]["installer_name"],
            },
        )
        assert resp.status_code == 200

        data = resp.json()
        assert data["success"] is True
        assert "commandId" in data
        assert data["commandId"].startswith("cancel_")

    def test_05_verify_cancelled_status(self, api_client, site_id, machine_id):
        """GET detail confirms the target status is now 'cancelled'."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.get(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200

        deployment = resp.json()["deployment"]
        target = next(
            (t for t in deployment["targets"] if t["machineId"] == machine_id),
            None,
        )
        assert target is not None, f"Target {machine_id} not found in deployment"
        assert target["status"] == "cancelled"
        assert "cancelledAt" in target

    def test_06_delete_deployment(self, api_client, site_id):
        """DELETE removes deployment once all targets are terminal."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.delete(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        # cancelled is terminal, so this should succeed
        assert resp.status_code == 200, f"Delete failed ({resp.status_code}): {resp.text}"
        assert resp.json()["success"] is True

    def test_07_verify_deleted(self, api_client, site_id):
        """GET returns 404 after deletion."""
        assert self.deployment_id is not None, "Depends on test_01"
        resp = api_client.get(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 404


@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestMultiMachineDeployment:
    """Test deployment targeting multiple machines.

    Verifies that cancelling one target does not affect the others.
    Uses Inno Setup installer (VLC) for variety.

    NOTE: Requires OWLETTE_MACHINE_ID_2 env var for a second machine.
    If not set, the test is skipped.
    """

    deployment_id: str | None = None

    @pytest.fixture(autouse=True)
    def _require_second_machine(self, request):
        import os
        if not os.environ.get("OWLETTE_MACHINE_ID_2"):
            pytest.skip("OWLETTE_MACHINE_ID_2 not set — skipping multi-machine tests")

    @pytest.fixture
    def machine_id_2(self):
        import os
        return os.environ["OWLETTE_MACHINE_ID_2"]

    def test_01_create_multi_target(self, api_client, site_id, machine_id, machine_id_2, deployment_cleanup):
        """Create deployment targeting two machines."""
        installer = INSTALLERS["inno_setup"]
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": installer["name"],
            "installer_name": installer["installer_name"],
            "installer_url": installer["installer_url"],
            "silent_flags": installer["silent_flags"],
            "machineIds": [machine_id, machine_id_2],
        })
        assert resp.status_code == 200
        data = resp.json()
        TestMultiMachineDeployment.deployment_id = data["deploymentId"]
        deployment_cleanup.append((data["deploymentId"], [machine_id, machine_id_2]))

    def test_02_verify_both_targets(self, api_client, site_id, machine_id, machine_id_2):
        """Both machines appear as targets."""
        assert self.deployment_id is not None
        resp = api_client.get(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200
        targets = resp.json()["deployment"]["targets"]
        target_ids = [t["machineId"] for t in targets]
        assert machine_id in target_ids
        assert machine_id_2 in target_ids

    def test_03_cancel_one_target(self, api_client, site_id, machine_id):
        """Cancel only the first machine."""
        assert self.deployment_id is not None
        resp = api_client.post(
            f"/api/admin/deployments/{self.deployment_id}/cancel",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "installer_name": INSTALLERS["inno_setup"]["installer_name"],
            },
        )
        assert resp.status_code == 200

    def test_04_verify_partial_cancel(self, api_client, site_id, machine_id, machine_id_2):
        """First machine is cancelled, second is unchanged."""
        assert self.deployment_id is not None
        resp = api_client.get(
            f"/api/admin/deployments/{self.deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200
        targets = resp.json()["deployment"]["targets"]

        t1 = next(t for t in targets if t["machineId"] == machine_id)
        t2 = next(t for t in targets if t["machineId"] == machine_id_2)
        assert t1["status"] == "cancelled"
        assert t2["status"] != "cancelled"  # still pending/in_progress


@pytest.mark.api
@pytest.mark.integration
class TestDeploymentInstallerTypes:
    """Verify deployment creation works with each major installer type.

    These tests only validate the API accepts the deployment — they don't
    wait for the agent to actually download/install (that's an E2E concern).
    """

    @pytest.mark.parametrize("installer_key,installer", list(INSTALLERS.items()))
    def test_create_with_installer_type(
        self, api_client, site_id, machine_id, deployment_cleanup, installer_key, installer
    ):
        """Create deployment with {installer_key} installer type."""
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": f"Test: {installer['name']}",
            "installer_name": installer["installer_name"],
            "installer_url": installer["installer_url"],
            "silent_flags": installer["silent_flags"],
            "verify_path": installer.get("verify_path"),
            "machineIds": [machine_id],
        })
        assert resp.status_code == 200, (
            f"Failed to create {installer_key} deployment: {resp.text}"
        )

        data = resp.json()
        assert data["success"] is True
        assert data["deploymentId"].startswith("deploy-")
        deployment_cleanup.append((data["deploymentId"], [machine_id]))

        # Verify the deployment is retrievable with correct data
        detail_resp = api_client.get(
            f"/api/admin/deployments/{data['deploymentId']}",
            params={"siteId": site_id},
        )
        assert detail_resp.status_code == 200
        deployment = detail_resp.json()["deployment"]
        assert deployment["installer_name"] == installer["installer_name"]
        assert deployment["installer_url"] == installer["installer_url"]
        assert deployment["silent_flags"] == installer["silent_flags"]


@pytest.mark.api
@pytest.mark.integration
class TestDeploymentValidation:
    """Tests for deployment validation and error handling."""

    def test_create_missing_fields(self, api_client, site_id):
        """POST with missing required fields returns 400."""
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "Incomplete",
        })
        assert resp.status_code == 400

    def test_create_empty_machine_ids(self, api_client, site_id):
        """POST with empty machineIds array returns 400."""
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "No targets",
            "installer_name": "test.exe",
            "installer_url": "https://example.com/test.exe",
            "silent_flags": "/S",
            "machineIds": [],
        })
        assert resp.status_code == 400

    def test_create_machine_ids_not_array(self, api_client, site_id):
        """POST with non-array machineIds returns 400."""
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": "Bad type",
            "installer_name": "test.exe",
            "installer_url": "https://example.com/test.exe",
            "silent_flags": "/S",
            "machineIds": "not-an-array",
        })
        assert resp.status_code == 400

    def test_get_nonexistent_deployment(self, api_client, site_id):
        """GET for a nonexistent deployment ID returns 404."""
        resp = api_client.get(
            "/api/admin/deployments/deploy-nonexistent-99999",
            params={"siteId": site_id},
        )
        assert resp.status_code == 404

    def test_delete_missing_site_id(self, api_client):
        """DELETE without siteId returns 400."""
        resp = api_client.delete("/api/admin/deployments/deploy-123")
        assert resp.status_code == 400

    def test_cancel_missing_fields(self, api_client):
        """POST cancel without required body fields returns 400."""
        resp = api_client.post(
            "/api/admin/deployments/deploy-123/cancel",
            json={"siteId": "site1"},
        )
        assert resp.status_code == 400

    def test_cancel_nonexistent_deployment(self, api_client, site_id, machine_id):
        """POST cancel for a nonexistent deployment returns 404."""
        resp = api_client.post(
            "/api/admin/deployments/deploy-nonexistent-99999/cancel",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "installer_name": "fake.exe",
            },
        )
        assert resp.status_code == 404

    def test_list_with_limit(self, api_client, site_id):
        """GET with limit param returns at most that many deployments."""
        resp = api_client.get(
            "/api/admin/deployments",
            params={"siteId": site_id, "limit": "2"},
        )
        assert resp.status_code == 200
        assert len(resp.json()["deployments"]) <= 2

    def test_list_missing_site_id(self, api_client):
        """GET without siteId returns 400."""
        resp = api_client.get("/api/admin/deployments")
        assert resp.status_code == 400
