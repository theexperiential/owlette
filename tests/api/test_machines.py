"""
Machine Endpoint Tests

Tests for GET /api/admin/machines and GET /api/admin/machines/status.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestListMachines:
    """Tests for GET /api/admin/machines."""

    def test_list_machines(self, api_client, site_id):
        """Returns a list of machines for the site."""
        resp = api_client.get("/api/admin/machines", params={"siteId": site_id})
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data.get("machines"), list)

    def test_missing_site_id_returns_400(self, api_client):
        """Missing siteId query param returns 400."""
        resp = api_client.get("/api/admin/machines")
        assert resp.status_code == 400


@pytest.mark.api
@pytest.mark.readonly
class TestMachineStatus:
    """Tests for GET /api/admin/machines/status."""

    def test_machine_status(self, api_client, site_id, machine_id):
        """Returns detailed status for a specific machine."""
        resp = api_client.get(
            "/api/admin/machines/status",
            params={"siteId": site_id, "machineId": machine_id},
        )
        assert resp.status_code == 200

    def test_missing_params_returns_400(self, api_client, site_id):
        """Missing machineId returns 400."""
        resp = api_client.get(
            "/api/admin/machines/status",
            params={"siteId": site_id},
        )
        assert resp.status_code == 400
