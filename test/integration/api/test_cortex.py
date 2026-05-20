"""
Cortex conversation endpoint integration tests.

Read-only coverage for the canonical public Cortex conversation surface.
Mutating create/send/rename/delete flows stay in the web/CLI/SDK unit suites.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestCortexConversations:
    """Tests for canonical /api/cortex/conversations routes."""

    def test_list_cortex_conversations(self, api_client, site_id):
        """GET /api/cortex/conversations returns a paginated conversation list."""
        resp = api_client.get(
            "/api/cortex/conversations",
            params={"siteId": site_id, "page_size": "2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert isinstance(data["data"]["conversations"], list)
        assert "next_page_token" in data["data"]

    def test_list_cortex_conversations_invalid_site(self, api_client):
        """GET /api/cortex/conversations validates siteId shape."""
        resp = api_client.get(
            "/api/cortex/conversations",
            params={"siteId": "../bad"},
        )
        assert resp.status_code == 400
        assert resp.headers["content-type"].startswith("application/problem+json")
