"""
Authentication Edge Case Tests

Verifies that the API correctly rejects unauthenticated and improperly
authenticated requests across all auth methods.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestAuthRejection:
    """Tests that invalid/missing auth is properly rejected."""

    def test_no_auth_returns_401(self, api_url):
        """Request with no auth headers returns 401."""
        import requests
        resp = requests.get(f"{api_url}/api/admin/machines", params={"siteId": "test"})
        assert resp.status_code == 401

    def test_invalid_api_key_returns_401(self, api_url):
        """Request with an invalid API key returns 401."""
        import requests
        resp = requests.get(
            f"{api_url}/api/admin/machines",
            params={"siteId": "test"},
            headers={"x-api-key": "owk_completely_invalid_key_here"},
        )
        assert resp.status_code == 401

    def test_invalid_bearer_token_returns_401(self, api_url):
        """Request with an invalid Bearer token returns 401."""
        import requests
        resp = requests.get(
            f"{api_url}/api/admin/machines",
            params={"siteId": "test"},
            headers={"Authorization": "Bearer invalid-token-garbage"},
        )
        assert resp.status_code == 401

    def test_valid_api_key_succeeds(self, api_client, site_id):
        """Request with a valid API key returns 200."""
        resp = api_client.get("/api/admin/machines", params={"siteId": site_id})
        assert resp.status_code == 200
        data = resp.json()
        assert "machines" in data or "error" not in data
