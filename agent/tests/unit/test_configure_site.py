"""Tests for configure_site.py pairing flow."""

import sys
from unittest.mock import MagicMock, patch

import pytest

try:
    import shared_utils
    import configure_site

    # Patch secure_storage before importing auth_manager since it may require
    # Windows-specific setup.
    mock_storage = MagicMock()
    mock_storage.get_access_token.return_value = (None, None)
    mock_storage.get_site_id.return_value = None
    mock_storage.get_refresh_token.return_value = "mock-refresh-token"
    mock_storage.has_refresh_token.return_value = True
    mock_storage.save_access_token.return_value = True
    mock_storage.save_refresh_token.return_value = True
    mock_storage.save_site_id.return_value = True

    with patch("secure_storage.get_storage", return_value=mock_storage), \
         patch("secure_storage.SecureStorage", return_value=mock_storage):
        from auth_manager import AuthManager
except ImportError as exc:
    pytest.skip(f"configure_site dependencies not importable: {exc}", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"configure_site import failed: {exc}", allow_module_level=True)


_MOCK_MODULES = {
    "win32api": MagicMock(),
    "win32con": MagicMock(),
    "win32event": MagicMock(),
    "win32service": MagicMock(),
    "win32serviceutil": MagicMock(),
    "servicemanager": MagicMock(),
    "win32ts": MagicMock(),
    "win32process": MagicMock(),
    "win32gui": MagicMock(),
    "win32security": MagicMock(),
    "pywintypes": MagicMock(),
    "wmi": MagicMock(),
}


def _storage():
    storage = MagicMock()
    storage.get_access_token.return_value = (None, None)
    storage.get_site_id.return_value = None
    storage.get_refresh_token.return_value = "mock-refresh-token"
    storage.has_refresh_token.return_value = True
    storage.save_access_token.return_value = True
    storage.save_refresh_token.return_value = True
    storage.save_site_id.return_value = True
    return storage


def _poll_response():
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "accessToken": "access-123",
        "refreshToken": "refresh-456",
        "expiresIn": 3600,
        "siteId": "site-abc",
    }
    return response


def _run_add_flow(add_phrase="silver-compass-drift"):
    with patch.object(
        configure_site,
        "_determine_environment",
        return_value=("production", "https://owlette.app/api", "owlette-prod-90a12"),
    ), \
         patch.object(configure_site, "_save_config"), \
         patch("requests.post", return_value=_poll_response()) as mock_post:
        result = configure_site.run_pairing_flow(
            api_base="https://owlette.app/api",
            add_phrase=add_phrase,
            show_prompts=False,
        )

    return result, mock_post


def test_add_poll_includes_machine_id_and_version():
    """The /ADD= poll should identify the agent host and version."""
    auth_manager = MagicMock()
    auth_manager.machine_id = "TEST-MACHINE"
    auth_manager.storage = _storage()

    with patch("auth_manager.AuthManager", return_value=auth_manager):
        result, mock_post = _run_add_flow()

    assert result == (True, "Configuration successful", "site-abc")
    mock_post.assert_called_once()
    payload = mock_post.call_args.kwargs["json"]
    assert payload == {
        "pairPhrase": "silver-compass-drift",
        "machineId": auth_manager.machine_id,
        "version": shared_utils.APP_VERSION,
    }


def test_machine_id_uses_shared_hostname_source(monkeypatch):
    """AuthManager, FirebaseClient, and /ADD= poll should share hostname source."""
    sentinel = "SENTINEL-HOST"
    storage = _storage()
    monkeypatch.setattr(shared_utils, "get_hostname", lambda: sentinel)
    monkeypatch.setattr("auth_manager.get_storage", lambda: storage)

    auth_manager = AuthManager(api_base="https://owlette.app/api", storage=storage)

    patches = {
        name: mock
        for name, mock in _MOCK_MODULES.items()
        if name not in sys.modules
    }
    with patch.dict("sys.modules", patches):
        from firebase_client import FirebaseClient

        firebase_auth = MagicMock(spec=AuthManager)
        firebase_auth.get_valid_token.return_value = "access-123"
        firebase_auth.is_authenticated.return_value = True
        firebase_client = FirebaseClient(
            auth_manager=firebase_auth,
            project_id="test-project",
            site_id="site-abc",
        )

    result, mock_post = _run_add_flow()

    assert result == (True, "Configuration successful", "site-abc")
    assert auth_manager.machine_id == sentinel
    assert firebase_client.machine_id == sentinel
    assert mock_post.call_args.kwargs["json"]["machineId"] == sentinel
