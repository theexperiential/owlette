"""
Logs and audit-log endpoint integration tests.

Read-only coverage for the canonical public log surfaces.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestLogEndpoints:
    """Tests for operational logs and tamper-evident audit records."""

    def test_list_operational_logs(self, api_client, site_id):
        """GET /api/sites/{siteId}/logs returns a paginated logs array."""
        resp = api_client.get(
            f"/api/sites/{site_id}/logs",
            params={"page_size": "2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["siteId"] == site_id
        assert isinstance(data["logs"], list)
        assert "next_page_token" in data

    def test_get_operational_log_when_present(self, api_client, site_id):
        """GET /api/sites/{siteId}/logs/{logId} returns detail for listed logs."""
        list_resp = api_client.get(
            f"/api/sites/{site_id}/logs",
            params={"page_size": "1"},
        )
        assert list_resp.status_code == 200
        logs = list_resp.json()["logs"]
        if not logs:
            pytest.skip("No operational logs present for this site")

        log_id = logs[0]["id"]
        detail_resp = api_client.get(f"/api/sites/{site_id}/logs/{log_id}")
        assert detail_resp.status_code == 200
        detail = detail_resp.json()
        assert detail["id"] == log_id
        assert detail["siteId"] == site_id

    def test_list_audit_log(self, api_client, site_id):
        """GET /api/sites/{siteId}/audit-log returns canonical pagination fields."""
        resp = api_client.get(
            f"/api/sites/{site_id}/audit-log",
            params={"page_size": "2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["siteId"] == site_id
        assert isinstance(data["records"], list)
        assert "next_page_token" in data

    def test_get_audit_record_when_present(self, api_client, site_id):
        """GET /api/sites/{siteId}/audit-log/{hash} returns verification data."""
        list_resp = api_client.get(
            f"/api/sites/{site_id}/audit-log",
            params={"page_size": "1"},
        )
        assert list_resp.status_code == 200
        records = list_resp.json()["records"]
        if not records:
            pytest.skip("No audit records present for this site")

        record_hash = records[0]["hash"]
        detail_resp = api_client.get(
            f"/api/sites/{site_id}/audit-log/{record_hash}",
        )
        assert detail_resp.status_code == 200
        detail = detail_resp.json()
        assert detail["hash"] == record_hash
        assert "verification" in detail
