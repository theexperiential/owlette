"""
Installer Endpoint Integration Tests

Tests for GET /api/admin/installer/latest and /versions.
Read-only tests — no actual uploads.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestInstallerEndpoints:
    """Tests for installer metadata endpoints."""

    def test_get_latest_installer(self, api_client):
        """GET /installer/latest returns installer metadata."""
        resp = api_client.get("/api/admin/installer/latest")
        assert resp.status_code in (200, 404)  # 404 if no installer uploaded yet
        if resp.status_code == 200:
            data = resp.json()
            assert data["success"] is True
            assert "installer" in data
            installer = data["installer"]
            assert "version" in installer

    def test_list_versions(self, api_client):
        """GET /installer/versions returns version array."""
        resp = api_client.get("/api/admin/installer/versions")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert isinstance(data["versions"], list)

    def test_list_versions_with_limit(self, api_client):
        """GET /installer/versions?limit=2 respects limit."""
        resp = api_client.get("/api/admin/installer/versions", params={"limit": "2"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["versions"]) <= 2
