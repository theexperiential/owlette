"""
Thin wrapper around requests.Session for API integration tests.

Provides:
- Base URL prefixing (so tests just use paths like "/api/admin/processes")
- JSON response parsing with error context
- Consistent logging
"""

import logging
import requests

logger = logging.getLogger(__name__)


class ApiClient:
    """Authenticated API client for integration tests."""

    def __init__(self, session: requests.Session, base_url: str):
        self.session = session
        self.base_url = base_url

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def get(self, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        logger.info(f"GET {url}")
        resp = self.session.get(url, **kwargs)
        logger.info(f"  -> {resp.status_code}")
        return resp

    def post(self, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        logger.info(f"POST {url}")
        resp = self.session.post(url, **kwargs)
        logger.info(f"  -> {resp.status_code}")
        return resp

    def patch(self, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        logger.info(f"PATCH {url}")
        resp = self.session.patch(url, **kwargs)
        logger.info(f"  -> {resp.status_code}")
        return resp

    def put(self, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        logger.info(f"PUT {url}")
        resp = self.session.put(url, **kwargs)
        logger.info(f"  -> {resp.status_code}")
        return resp

    def delete(self, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        logger.info(f"DELETE {url}")
        resp = self.session.delete(url, **kwargs)
        logger.info(f"  -> {resp.status_code}")
        return resp
