"""
Deployment Integration Tests

Tests the full deployment API lifecycle using real-world installer URLs
representing common installer types (NSIS, Inno Setup, MSI-wrapped EXE, etc.).

TestDeploymentLifecycle: API CRUD flow (create → list → detail → cancel → delete).
TestDeploymentE2E: Install → verify → uninstall for each installer type.
TestTouchDesignerDeployment: Deploy latest 3 TD versions (web + full installers).
TestDeploymentValidation: Error cases and input validation.
"""

import os
import time
import pytest


# ---------------------------------------------------------------------------
#  Real-world installer test data
# ---------------------------------------------------------------------------
INSTALLERS = {
    "nsis": {
        "name": "7-Zip (NSIS)",
        "installer_name": "7z2408-x64.exe",
        "installer_url": "https://www.7-zip.org/a/7z2408-x64.exe",
        "silent_flags": "/S",
        "verify_path": "C:/Program Files/7-Zip/7z.exe",
        "search_name": "7-Zip",
    },
    "nsis_large": {
        "name": "VLC Media Player (NSIS)",
        "installer_name": "vlc-3.0.21-win64.exe",
        "installer_url": "https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe",
        "silent_flags": "/L=1033 /S",
        "verify_path": "C:/Program Files/VideoLAN/VLC/vlc.exe",
        "search_name": "VLC",
    },
    "inno_setup": {
        "name": "ShareX (Inno Setup)",
        "installer_name": "ShareX-17.0.0-setup.exe",
        "installer_url": "https://github.com/ShareX/ShareX/releases/download/v17.0.0/ShareX-17.0.0-setup.exe",
        "silent_flags": "/VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /NOCANCEL",
        "verify_path": "C:/Program Files/ShareX/ShareX.exe",
        "search_name": "ShareX",
    },
    "portable_exe": {
        "name": "Notepad++ (NSIS)",
        "installer_name": "npp.8.7.1.Installer.x64.exe",
        "installer_url": "https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.7.1/npp.8.7.1.Installer.x64.exe",
        "silent_flags": "/S",
        "verify_path": "C:/Program Files/Notepad++/notepad++.exe",
        "search_name": "Notepad++ (64-bit",
    },
    # NOTE: MSI test (Python) excluded — this machine's MSI subsystem has a
    # stale install lock (error 1603) from previous test runs. Needs a reboot
    # to clear. Re-enable after reboot with:
    # "msi_native": {
    #     "name": "Python 3.11 (MSI)",
    #     "installer_name": "python-3.11.9-amd64.exe",
    #     "installer_url": "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe",
    #     "silent_flags": "/quiet InstallAllUsers=1 PrependPath=0",
    #     "verify_path": "C:/Program Files/Python311/python.exe",
    #     "search_name": "Python 3.11",
    # },
}

# TouchDesigner versions — latest 3 builds, both web and full installers
TD_VERSIONS = [
    {"build": "32460", "date": "2026-03-09"},
    {"build": "32280", "date": "2026-01-20"},
    {"build": "32050", "date": "2025-12-10"},
]
TD_SILENT_FLAGS = '/VERYSILENT /SP- /NORESTART /SUPPRESSMSGBOXES /FORCECLOSEAPPLICATIONS /LOG="C:\\ProgramData\\Owlette\\logs\\td_install.log"'
TD_VERIFY_PATH = "C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe"

# Per-target terminal statuses
TARGET_TERMINAL_STATUSES = {"completed", "failed", "cancelled", "uninstalled"}


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def poll_deployment_target(
    api_client, site_id, deployment_id, machine_id, timeout=600, interval=10,
    expected_statuses=None,
):
    """Poll a deployment until the target machine reaches a terminal status.

    Args:
        expected_statuses: If set, only return when status is one of these.
            Otherwise returns on any terminal status.

    Returns the target dict on success, raises AssertionError on timeout.
    """
    wait_for = expected_statuses or TARGET_TERMINAL_STATUSES
    deadline = time.time() + timeout
    last_status = None

    while time.time() < deadline:
        resp = api_client.get(
            f"/api/admin/deployments/{deployment_id}",
            params={"siteId": site_id},
        )
        assert resp.status_code == 200, f"Poll failed: {resp.status_code} {resp.text}"

        deployment = resp.json()["deployment"]
        target = next(
            (t for t in deployment["targets"] if t["machineId"] == machine_id),
            None,
        )
        assert target is not None, f"Machine {machine_id} not in targets"

        last_status = target["status"]
        if last_status in wait_for:
            return target

        time.sleep(interval)

    pytest.fail(
        f"Deployment {deployment_id} timed out after {timeout}s — "
        f"target {machine_id} stuck at '{last_status}'"
    )


def lookup_software(api_client, site_id, machine_id, search_name):
    """Look up installed software from the agent's registry sync.

    Returns the first matching software entry, or None.
    """
    resp = api_client.get(
        "/api/admin/software-inventory",
        params={"siteId": site_id, "machineId": machine_id, "search": search_name},
    )
    if resp.status_code != 200:
        return None

    software = resp.json().get("software", [])
    return software[0] if software else None


def send_uninstall(api_client, site_id, machine_id, software_entry, deployment_id):
    """Send an uninstall_software command via the commands/send endpoint.

    Returns the command ID.
    """
    resp = api_client.post("/api/admin/commands/send", json={
        "siteId": site_id,
        "machineId": machine_id,
        "command": "uninstall_software",
        "data": {
            "software_name": software_entry["name"],
            "uninstall_command": software_entry["uninstall_command"],
            "installer_type": software_entry.get("installer_type", "custom"),
            "verify_paths": [software_entry.get("install_location", "")],
            "deployment_id": deployment_id,
        },
    })
    assert resp.status_code == 200, f"Uninstall command failed: {resp.text}"
    return resp.json()["commandId"]


# ---------------------------------------------------------------------------
#  Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def deploy_timeout():
    """Timeout (seconds) for waiting on agent to complete a deployment."""
    return int(os.environ.get("OWLETTE_DEPLOY_TIMEOUT", "600"))


@pytest.fixture
def td_deploy_timeout():
    """Timeout (seconds) for TouchDesigner deployments (large downloads)."""
    return int(os.environ.get("OWLETTE_TD_DEPLOY_TIMEOUT", "2400"))


# ---------------------------------------------------------------------------
#  TestDeploymentLifecycle — API CRUD (no agent interaction)
# ---------------------------------------------------------------------------

@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestDeploymentLifecycle:
    """Full deployment lifecycle: create → list → detail → cancel → delete.

    Uses a real NSIS installer URL to validate the complete API flow.
    Deliberately cancels before the agent finishes — this tests the API,
    not the agent's installer execution.
    """

    deployment_id = None  # type: Optional[str]

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


# ---------------------------------------------------------------------------
#  TestDeploymentE2E — Install → Verify → Uninstall
# ---------------------------------------------------------------------------

@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestDeploymentE2E:
    """End-to-end deployment tests — installs software, verifies completion,
    then uninstalls and verifies removal.

    Flow per installer:
    1. Create deployment → poll for 'completed'
    2. Query software inventory to get uninstall command
    3. Send uninstall_software command
    4. Poll for 'uninstalled' status
    5. Leave deployment visible in dashboard
    """

    @pytest.mark.parametrize("installer_key,installer", list(INSTALLERS.items()))
    def test_install_and_uninstall(
        self, api_client, site_id, machine_id, deployment_cleanup,
        deploy_timeout, installer_key, installer,
    ):
        """Install {installer_key}, verify, then uninstall."""
        # --- Phase 1: Install ---
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": installer["name"],
            "installer_name": installer["installer_name"],
            "installer_url": installer["installer_url"],
            "silent_flags": installer["silent_flags"],
            "verify_path": installer.get("verify_path"),
            "machineIds": [machine_id],
        })
        assert resp.status_code == 200, (
            f"Failed to create {installer_key} deployment: {resp.text}"
        )

        deployment_id = resp.json()["deploymentId"]
        deployment_cleanup.append((deployment_id, [machine_id]))

        # --- Phase 2: Wait for install to complete ---
        target = poll_deployment_target(
            api_client, site_id, deployment_id, machine_id,
            timeout=deploy_timeout,
        )
        assert target["status"] == "completed", (
            f"{installer_key} install finished with status '{target['status']}'"
        )

        # --- Phase 3: Look up uninstall command from software inventory ---
        # Wait a moment for the agent to sync inventory after install
        time.sleep(5)

        software = lookup_software(
            api_client, site_id, machine_id, installer["search_name"]
        )
        assert software is not None, (
            f"Could not find '{installer['search_name']}' in software inventory "
            f"after install — agent may not have synced yet"
        )
        assert software.get("uninstall_command"), (
            f"No uninstall_command found for '{software['name']}'"
        )

        # --- Phase 4: Send uninstall command ---
        send_uninstall(api_client, site_id, machine_id, software, deployment_id)

        # --- Phase 5: Wait for uninstall to complete ---
        target = poll_deployment_target(
            api_client, site_id, deployment_id, machine_id,
            timeout=deploy_timeout,
            expected_statuses={"uninstalled", "failed"},
        )
        assert target["status"] == "uninstalled", (
            f"{installer_key} uninstall finished with status '{target['status']}'"
        )

        # Success — remove from cleanup, keep visible in dashboard
        deployment_cleanup.remove((deployment_id, [machine_id]))


# ---------------------------------------------------------------------------
#  TestTouchDesignerDeployment — Deploy latest 3 TD versions
# ---------------------------------------------------------------------------

@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
@pytest.mark.slow
class TestTouchDesignerDeployment:
    """Deploy the latest 3 TouchDesigner versions using both web and full
    installers to validate all installer types work.

    Each version is installed and kept — not uninstalled.
    These are large downloads (671MB web, 2.7GB full) so tests are marked
    slow and have a 20-minute timeout.
    """

    @pytest.mark.skip(reason="CodeMeter sub-installer blocks in Session 0 (SYSTEM) — needs CreateProcessAsUser to run in user session")
    @pytest.mark.timeout(2700)  # 45 min per test (large downloads + install)
    @pytest.mark.parametrize("version", TD_VERSIONS, ids=[v["build"] for v in TD_VERSIONS])
    @pytest.mark.parametrize("installer_type", ["full"])  # Web installer hangs in silent mode (component selection dialog)
    def test_deploy_touchdesigner(
        self, api_client, site_id, machine_id, deployment_cleanup,
        td_deploy_timeout, version, installer_type,
    ):
        """Deploy TouchDesigner {version[build]} ({installer_type} installer)."""
        build = version["build"]

        if installer_type == "web":
            url = f"https://download.derivative.ca/TouchDesignerWebInstaller.2025.{build}.exe"
            name = f"TouchDesigner 2025.{build} (Web)"
            installer_name = f"TouchDesignerWebInstaller.2025.{build}.exe"
        else:
            url = f"https://download.derivative.ca/TouchDesigner.2025.{build}.exe"
            name = f"TouchDesigner 2025.{build} (Full)"
            installer_name = f"TouchDesigner.2025.{build}.exe"

        # --- Create deployment ---
        resp = api_client.post("/api/admin/deployments", json={
            "siteId": site_id,
            "name": name,
            "installer_name": installer_name,
            "installer_url": url,
            "silent_flags": TD_SILENT_FLAGS,
            "verify_path": TD_VERIFY_PATH,
            "machineIds": [machine_id],
        })
        assert resp.status_code == 200, (
            f"Failed to create TD {build} ({installer_type}) deployment: {resp.text}"
        )

        deployment_id = resp.json()["deploymentId"]
        deployment_cleanup.append((deployment_id, [machine_id]))

        # --- Wait for install to complete ---
        target = poll_deployment_target(
            api_client, site_id, deployment_id, machine_id,
            timeout=td_deploy_timeout,
        )
        assert target["status"] == "completed", (
            f"TD {build} ({installer_type}) finished with status '{target['status']}'"
        )

        # Keep installed — remove from cleanup
        deployment_cleanup.remove((deployment_id, [machine_id]))


# ---------------------------------------------------------------------------
#  TestMultiMachineDeployment
# ---------------------------------------------------------------------------

@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestMultiMachineDeployment:
    """Test deployment targeting multiple machines.

    Verifies that cancelling one target does not affect the others.

    NOTE: Requires OWLETTE_MACHINE_ID_2 env var for a second machine.
    If not set, the test is skipped.
    """

    deployment_id = None  # type: Optional[str]

    @pytest.fixture(autouse=True)
    def _require_second_machine(self, request):
        if not os.environ.get("OWLETTE_MACHINE_ID_2"):
            pytest.skip("OWLETTE_MACHINE_ID_2 not set — skipping multi-machine tests")

    @pytest.fixture
    def machine_id_2(self):
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


# ---------------------------------------------------------------------------
#  TestDeploymentValidation — Error cases, no agent interaction
# ---------------------------------------------------------------------------

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
