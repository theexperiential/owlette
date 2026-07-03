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


def _interactive_auth_manager():
    auth_manager = MagicMock()
    auth_manager.request_device_code.return_value = {
        "pairPhrase": "admit-nice-stereo",
        "deviceCode": "device-123",
        "verificationUri": "https://owlette.app/add",
        "pairingUrl": "https://owlette.app/add?phrase=admit-nice-stereo",
        "interval": 1,
        "expiresIn": 600,
    }

    def _poll_device_code(*_args, **_kwargs):
        auth_manager._site_id = "site-abc"
        return True

    auth_manager.poll_device_code.side_effect = _poll_device_code
    return auth_manager


def _run_interactive_flow(tmp_path, **kwargs):
    auth_manager = _interactive_auth_manager()
    config_path = tmp_path / "config.json"

    with patch("auth_manager.AuthManager", return_value=auth_manager), \
         patch.object(
             configure_site,
             "_determine_environment",
             return_value=("production", "https://owlette.app/api", "owlette-prod-90a12"),
         ), \
         patch.object(configure_site, "CONFIG_PATH", config_path), \
         patch.object(configure_site, "_copy_to_clipboard", return_value=True), \
         patch.object(configure_site, "_save_config") as mock_save_config, \
         patch.object(configure_site, "_open_browser", return_value=True) as mock_open_browser, \
         patch.object(configure_site, "_prompt_open_browser_async") as mock_prompt_open:
        result = configure_site.run_pairing_flow(
            api_base="https://owlette.app/api",
            show_prompts=True,
            **kwargs,
        )

    return result, auth_manager, mock_save_config, mock_open_browser, mock_prompt_open


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


def test_interactive_default_prompts_without_opening_browser(tmp_path, capsys):
    """Interactive pairing should offer Enter-to-open, not launch a browser."""
    result, auth_manager, _save_config, mock_open_browser, mock_prompt_open = _run_interactive_flow(tmp_path)

    assert result == (True, "Configuration successful", "site-abc")
    mock_open_browser.assert_not_called()
    mock_prompt_open.assert_called_once_with("https://owlette.app/add?phrase=admit-nice-stereo")
    auth_manager.poll_device_code.assert_called_once()
    out = capsys.readouterr().out
    assert "press Enter to open the pairing page in your browser" in out
    assert "waiting for authorization" in out


def test_interactive_open_browser_flag_opens_immediately(tmp_path, capsys):
    """Explicit open_browser=True preserves the immediate-open opt-in path."""
    result, _auth_manager, _save_config, mock_open_browser, mock_prompt_open = _run_interactive_flow(
        tmp_path,
        open_browser=True,
    )

    assert result == (True, "Configuration successful", "site-abc")
    mock_open_browser.assert_called_once_with("https://owlette.app/add?phrase=admit-nice-stereo")
    mock_prompt_open.assert_not_called()
    out = capsys.readouterr().out
    assert "opened the pairing page in your browser" in out


def test_interactive_no_browser_suppresses_open_prompt(tmp_path, capsys):
    """--no-browser should leave only the printed URL and polling."""
    result, _auth_manager, _save_config, mock_open_browser, mock_prompt_open = _run_interactive_flow(
        tmp_path,
        prompt_open_browser=False,
    )

    assert result == (True, "Configuration successful", "site-abc")
    mock_open_browser.assert_not_called()
    mock_prompt_open.assert_not_called()
    out = capsys.readouterr().out
    assert "press Enter to open" not in out
    assert "approve at the link above from any device" in out


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
