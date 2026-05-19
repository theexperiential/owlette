"""
Webhook, quota, and event-stream public API integration tests.

These stay read-only: subscription mutations and outbound probe delivery are
covered in route/SDK unit tests where external receiver side effects can be
controlled.
"""

import pytest


@pytest.mark.api
@pytest.mark.readonly
class TestWebhookQuotaEvents:
    def test_list_webhooks(self, api_client, site_id):
        resp = api_client.get(
            "/api/webhooks",
            params={"siteId": site_id, "page_size": "2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data["webhooks"], list)
        assert "next_page_token" in data

    def test_quota_current(self, api_client, site_id):
        resp = api_client.get(f"/api/sites/{site_id}/quota")
        assert resp.status_code == 200
        data = resp.json()
        assert data["siteId"] == site_id
        assert "usedBytes" in data
        assert "pendingBytes" in data
        assert "limitBytes" in data
        assert isinstance(data["alarms"], list)

    def test_quota_history(self, api_client, site_id):
        resp = api_client.get(
            f"/api/sites/{site_id}/quota/history",
            params={"period": "7d"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["siteId"] == site_id
        assert data["period"] == "7d"
        assert data["days"] == 7
        assert isinstance(data["daily"], list)

    def test_events_stream_validates_event_filter(self, api_client, site_id):
        resp = api_client.get(
            "/api/events/stream",
            params={"siteId": site_id, "events": "not.a.real.event"},
        )
        assert resp.status_code == 400
        assert resp.headers["content-type"].startswith("application/problem+json")

    def test_events_stream_opens_scoped_sse(self, api_client, site_id):
        resp = api_client.get(
            "/api/events/stream",
            params={"siteId": site_id, "events": "version.published"},
            stream=True,
            timeout=10,
        )
        try:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            first_lines = []
            for line in resp.iter_lines(decode_unicode=True):
                first_lines.append(line)
                if line == "":
                    break
            block = "\n".join(first_lines)
            assert "event: connected" in block
            assert f'"siteId":"{site_id}"' in block
            assert '"transportOnly":true' in block
        finally:
            resp.close()
