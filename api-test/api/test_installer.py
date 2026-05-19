"""
Installer Endpoint Integration Tests

Read-only tests for the canonical /api/installer public management routes.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestInstallerEndpoints:
    """Tests for installer metadata endpoints."""

    def test_get_latest_installer(self, api_client):
        """GET /api/installer/latest returns active latest metadata."""
        resp = api_client.get("/api/installer/latest")
        assert resp.status_code in (200, 404)  # 404 if no installer uploaded yet
        if resp.status_code == 200:
            data = resp.json()
            assert "version" in data
            assert "download_url" in data
            assert data.get("deletedAt") in (None, 0)
        else:
            assert resp.json().get("code") == "latest_installer_not_found"

    def test_list_versions(self, api_client):
        """GET /api/installer returns a version array."""
        resp = api_client.get("/api/installer")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data["versions"], list)
        assert "next_page_token" in data

    def test_list_versions_with_page_size(self, api_client):
        """GET /api/installer?page_size=2 respects page size."""
        resp = api_client.get("/api/installer", params={"page_size": "2"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["versions"]) <= 2
