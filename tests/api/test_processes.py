"""
Process CRUD Integration Tests

Full lifecycle: create → read → update → set launch mode → delete.
Validation tests for error cases.
"""

import pytest


@pytest.mark.api
@pytest.mark.integration
@pytest.mark.destructive
class TestProcessLifecycle:
    """Full CRUD lifecycle for processes (tests run in order)."""

    process_id = None

    def test_01_create_process(self, api_client, site_id, machine_id):
        """POST creates a new process."""
        resp = api_client.post("/api/admin/processes", json={
            "siteId": site_id,
            "machineId": machine_id,
            "name": "Integration Test Process",
            "exe_path": "C:\\IntegrationTest\\nonexistent.exe",
            "cwd": "C:\\IntegrationTest",
            "launch_mode": "off",
        })
        assert resp.status_code == 200, f"Create failed: {resp.text}"
        data = resp.json()
        assert data["success"] is True
        assert "processId" in data
        TestProcessLifecycle.process_id = data["processId"]
        # Don't use process_cleanup here — test_06 handles deletion.
        # process_cleanup is function-scoped and would delete immediately after this test.

    def test_02_list_processes_contains_created(self, api_client, site_id, machine_id):
        """GET lists processes including the one we just created."""
        assert TestProcessLifecycle.process_id is not None, "Depends on test_01"
        resp = api_client.get("/api/admin/processes", params={
            "siteId": site_id,
            "machineId": machine_id,
        })
        assert resp.status_code == 200
        processes = resp.json()["processes"]
        ids = [p["id"] for p in processes]
        assert TestProcessLifecycle.process_id in ids

    def test_03_update_process_name(self, api_client, site_id, machine_id):
        """PATCH updates the process name."""
        assert TestProcessLifecycle.process_id is not None
        resp = api_client.patch(
            f"/api/admin/processes/{TestProcessLifecycle.process_id}",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "name": "Updated Integration Test Process",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_04_set_launch_mode_always(self, api_client, site_id, machine_id):
        """PATCH launch-mode to 'always'."""
        assert TestProcessLifecycle.process_id is not None
        resp = api_client.patch(
            f"/api/admin/processes/{TestProcessLifecycle.process_id}/launch-mode",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "mode": "always",
            },
        )
        assert resp.status_code == 200

    def test_05_set_launch_mode_scheduled(self, api_client, site_id, machine_id):
        """PATCH launch-mode to 'scheduled' with schedules."""
        assert TestProcessLifecycle.process_id is not None
        resp = api_client.patch(
            f"/api/admin/processes/{TestProcessLifecycle.process_id}/launch-mode",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "mode": "scheduled",
                "schedules": [{
                    "days": ["mon", "tue", "wed", "thu", "fri"],
                    "ranges": [{"start": "09:00", "stop": "17:00"}],
                }],
            },
        )
        assert resp.status_code == 200

    def test_06_delete_process(self, api_client, site_id, machine_id):
        """DELETE removes the process."""
        assert TestProcessLifecycle.process_id is not None
        resp = api_client.delete(
            f"/api/admin/processes/{TestProcessLifecycle.process_id}",
            params={"siteId": site_id, "machineId": machine_id},
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

    def test_07_verify_deleted(self, api_client, site_id, machine_id):
        """GET confirms the process is no longer listed."""
        assert TestProcessLifecycle.process_id is not None
        resp = api_client.get("/api/admin/processes", params={
            "siteId": site_id,
            "machineId": machine_id,
        })
        assert resp.status_code == 200
        ids = [p["id"] for p in resp.json()["processes"]]
        assert TestProcessLifecycle.process_id not in ids


@pytest.mark.api
@pytest.mark.integration
class TestProcessValidation:
    """Tests for input validation error cases."""

    def test_create_missing_name(self, api_client, site_id, machine_id):
        resp = api_client.post("/api/admin/processes", json={
            "siteId": site_id,
            "machineId": machine_id,
            "exe_path": "C:\\test.exe",
        })
        assert resp.status_code == 400

    def test_create_missing_exe_path(self, api_client, site_id, machine_id):
        resp = api_client.post("/api/admin/processes", json={
            "siteId": site_id,
            "machineId": machine_id,
            "name": "Test",
        })
        assert resp.status_code == 400

    def test_create_missing_site_id(self, api_client, machine_id):
        resp = api_client.post("/api/admin/processes", json={
            "machineId": machine_id,
            "name": "Test",
            "exe_path": "C:\\test.exe",
        })
        assert resp.status_code == 400

    def test_update_empty_fields(self, api_client, site_id, machine_id):
        resp = api_client.patch(
            "/api/admin/processes/nonexistent",
            json={"siteId": site_id, "machineId": machine_id},
        )
        assert resp.status_code == 400

    def test_delete_nonexistent(self, api_client, site_id, machine_id):
        resp = api_client.delete(
            "/api/admin/processes/nonexistent-id-12345",
            params={"siteId": site_id, "machineId": machine_id},
        )
        assert resp.status_code in (404, 500)  # 404 from ProcessConfigError

    def test_invalid_launch_mode(self, api_client, site_id, machine_id):
        resp = api_client.patch(
            "/api/admin/processes/any-id/launch-mode",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "mode": "invalid_mode",
            },
        )
        assert resp.status_code == 400

    def test_scheduled_without_schedules(self, api_client, site_id, machine_id):
        resp = api_client.patch(
            "/api/admin/processes/any-id/launch-mode",
            json={
                "siteId": site_id,
                "machineId": machine_id,
                "mode": "scheduled",
            },
        )
        assert resp.status_code == 400
