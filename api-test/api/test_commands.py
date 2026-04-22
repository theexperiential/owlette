"""
Command Sending Integration Tests

Tests for POST /api/admin/commands/send.
"""

import pytest


@pytest.mark.api
@pytest.mark.integration
class TestCommandSending:
    """Tests for the command sending endpoint."""

    def test_send_command_fire_and_forget(self, api_client, site_id, machine_id):
        """POST with wait=false returns immediately with commandId."""
        resp = api_client.post("/api/admin/commands/send", json={
            "siteId": site_id,
            "machineId": machine_id,
            "command": "restart_process",
            "data": {"process_name": "nonexistent_test_process"},
            "wait": False,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert "commandId" in data

    def test_send_command_missing_fields(self, api_client, site_id):
        """Missing required fields returns 400."""
        resp = api_client.post("/api/admin/commands/send", json={
            "siteId": site_id,
            # Missing machineId and command
        })
        assert resp.status_code == 400

    def test_send_command_with_wait_timeout(self, api_client, site_id, machine_id):
        """POST with wait=true and short timeout returns timeout status.

        No agent is processing in test env, so the command will time out.
        """
        resp = api_client.post("/api/admin/commands/send", json={
            "siteId": site_id,
            "machineId": machine_id,
            "command": "restart_process",
            "data": {"process_name": "nonexistent_process"},
            "wait": True,
            "timeout": 3,  # Short timeout to avoid long wait
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data.get("status") == "timeout" or "result" in data

    def test_send_restart_command(self, api_client, site_id, machine_id):
        """POST a restart_process command with process_name."""
        resp = api_client.post("/api/admin/commands/send", json={
            "siteId": site_id,
            "machineId": machine_id,
            "command": "restart_process",
            "data": {"process_name": "test_process"},
        })
        assert resp.status_code == 200
        assert "commandId" in resp.json()
