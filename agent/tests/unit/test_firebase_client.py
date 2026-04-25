"""Tests for firebase_client.py — high-level Firebase client (presence, metrics, commands)."""

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
import logging
import time
import sys

# Pre-mock Windows-specific and heavy dependencies before importing firebase_client
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

# Only patch modules that aren't already importable
_patches = {}
for mod_name, mock_obj in _MOCK_MODULES.items():
    if mod_name not in sys.modules:
        _patches[mod_name] = mock_obj

try:
    with patch.dict("sys.modules", _patches):
        from firebase_client import FirebaseClient
        from connection_manager import ConnectionManager, ConnectionState
        from firestore_rest_client import FirestoreRestClient
        from auth_manager import AuthManager
except ImportError as exc:
    pytest.skip(f"firebase_client not importable: {exc}", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"firebase_client import failed: {exc}", allow_module_level=True)


@pytest.fixture
def logger():
    return logging.getLogger("test_firebase_client")


@pytest.fixture
def mock_auth_manager():
    """Mock AuthManager that claims to be authenticated."""
    am = MagicMock(spec=AuthManager)
    am.get_valid_token.return_value = "fake-token"
    am.is_authenticated.return_value = True
    am._site_id = "test-site"
    am.machine_id = "TEST-MACHINE"
    am.api_base = "https://owlette.app/api"
    return am


@pytest.fixture
def mock_rest_client():
    """Pre-built mock FirestoreRestClient."""
    rc = MagicMock(spec=FirestoreRestClient)
    rc.get_document.return_value = None
    rc.set_document.return_value = None
    rc.update_document.return_value = None
    rc.delete_document.return_value = None
    rc.collection.return_value = MagicMock()
    return rc


@pytest.fixture
def firebase_client(mock_auth_manager, mock_rest_client):
    """Create a FirebaseClient with all dependencies mocked out."""
    with patch("firebase_client.FirestoreRestClient", return_value=mock_rest_client), \
         patch("firebase_client.shared_utils") as mock_su, \
         patch("firebase_client.registry_utils") as mock_ru:
        # shared_utils stubs
        mock_su.get_data_path.return_value = "/tmp/owlette"
        mock_su.get_system_metrics.return_value = {"cpu": 10, "memory": 50}
        mock_su.APP_VERSION = "2.2.1"

        try:
            client = FirebaseClient(
                auth_manager=mock_auth_manager,
                project_id="test-project",
                site_id="test-site",
            )
        except Exception:
            pytest.skip("FirebaseClient construction failed with mocks")
            return

        # Override db with our mock (constructor may or may not have set it)
        client.db = mock_rest_client
        return client


# ---------------------------------------------------------------------------
# TestInit — verify construction with mocked dependencies
# ---------------------------------------------------------------------------
class TestInit:
    def test_can_construct(self, firebase_client):
        """FirebaseClient should be constructable with mocked deps."""
        assert firebase_client is not None

    def test_has_connection_manager(self, firebase_client):
        assert firebase_client.connection_manager is not None
        assert isinstance(firebase_client.connection_manager, ConnectionManager)

    def test_site_id_stored(self, firebase_client):
        assert firebase_client.site_id == "test-site"

    def test_machine_id_is_set(self, firebase_client):
        """machine_id should be set (hostname or from config)."""
        assert firebase_client.machine_id is not None
        assert len(firebase_client.machine_id) > 0


# ---------------------------------------------------------------------------
# TestPresence — heartbeat writes to correct Firestore path
# ---------------------------------------------------------------------------
class TestPresence:
    def test_update_presence_calls_firestore(self, firebase_client, mock_rest_client):
        """_update_presence should write to Firestore via collection/document chain."""
        firebase_client.running = True
        # Ensure connected property returns True
        firebase_client.connection_manager._state = ConnectionState.CONNECTED

        # Set up the mock chain: collection().document().collection().document()
        mock_doc_ref = MagicMock()
        mock_machine_coll = MagicMock()
        mock_machine_coll.document.return_value = mock_doc_ref
        mock_site_doc = MagicMock()
        mock_site_doc.collection.return_value = mock_machine_coll
        mock_sites_coll = MagicMock()
        mock_sites_coll.document.return_value = mock_site_doc
        mock_rest_client.collection.return_value = mock_sites_coll

        firebase_client._update_presence(True)

        # Verify the chain was called
        mock_rest_client.collection.assert_called_with("sites")
        mock_sites_coll.document.assert_called_with("test-site")
        mock_site_doc.collection.assert_called_with("machines")
        mock_doc_ref.set.assert_called_once()
        # Verify the data includes 'online' field
        call_data = mock_doc_ref.set.call_args[0][0]
        assert call_data["online"] is True


# ---------------------------------------------------------------------------
# TestMetrics — _upload_metrics writes correct data structure
# ---------------------------------------------------------------------------
class TestMetrics:
    def test_upload_metrics_calls_firestore(self, firebase_client, mock_rest_client):
        """_upload_metrics should update the machine document with metrics."""
        firebase_client.running = True
        firebase_client.connection_manager._state = ConnectionState.CONNECTED

        # Set up the mock chain
        mock_doc_ref = MagicMock()
        mock_machine_coll = MagicMock()
        mock_machine_coll.document.return_value = mock_doc_ref
        mock_site_doc = MagicMock()
        mock_site_doc.collection.return_value = mock_machine_coll
        mock_sites_coll = MagicMock()
        mock_sites_coll.document.return_value = mock_site_doc
        mock_rest_client.collection.return_value = mock_sites_coll

        metrics_data = {
            "cpu_percent": 45.2,
            "memory_percent": 67.8,
            "processes": {"proc1": {"status": "running"}},
        }

        firebase_client._upload_metrics(metrics_data)

        # Should have called update on the document ref
        assert mock_doc_ref.update.called


# ---------------------------------------------------------------------------
# TestErrorHandling — connection errors handled gracefully
# ---------------------------------------------------------------------------
class TestErrorHandling:
    def test_presence_skipped_when_disconnected(self, firebase_client, mock_rest_client):
        """When disconnected, _update_presence should skip without error."""
        firebase_client.connection_manager._state = ConnectionState.DISCONNECTED

        # Should not raise and should not call Firestore
        firebase_client._update_presence(True)
        mock_rest_client.collection.assert_not_called()

    def test_presence_skipped_when_db_is_none(self, firebase_client):
        """When db is None, _update_presence should skip."""
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        firebase_client.db = None

        # Should not raise
        firebase_client._update_presence(True)


# ---------------------------------------------------------------------------
# TestEnsureDisplayModesCatalogue — A3.2 cache-by-signature guard
# ---------------------------------------------------------------------------
class TestEnsureDisplayModesCatalogue:
    """`_ensure_display_modes_catalogue` uploads on first call and skips
    subsequent calls with the same signatureHash. The dashboard dispatches an
    `enumerate_display_modes` command every time an operator opens the editor;
    the cache-by-hash guard keeps that cheap when the topology is stable.
    """

    def _canned_result(self, signature_hash: str = 'hash-abc-123'):
        return {
            'ok': True,
            'schemaVersion': 1,
            'signatureHash': signature_hash,
            'capturedAt': 1_700_000_000,
            'byEdidHash': {
                'edid-1': {
                    'modes': [
                        {'w': 3840, 'h': 2160, 'hz': 60},
                        {'w': 1920, 'h': 1080, 'hz': 60},
                    ],
                    'dpiScales': [100, 125, 150, 175, 200],
                },
            },
            'enumerationFailed': False,
        }

    def _patch_enumerate(self, monkeypatch, result):
        import firebase_client as fc
        monkeypatch.setattr(
            fc.display_manager,
            'enumerate_modes_via_user_session',
            lambda: result,
        )

    def test_uploads_on_first_call(self, firebase_client, mock_rest_client, monkeypatch):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        result = firebase_client._ensure_display_modes_catalogue()
        assert result['ok'] is True
        assert result['uploaded'] is True
        assert result['monitorCount'] == 1
        assert result['modeCount'] == 2
        # Cache is now populated.
        assert firebase_client._cached_display_modes_hash == 'hash-abc-123'

    def test_second_call_with_unchanged_hardware_is_noop(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        # First call — uploads.
        firebase_client._ensure_display_modes_catalogue()
        # Reset the mock so we can assert `set()` is NOT called on the second call.
        mock_rest_client.reset_mock()
        second = firebase_client._ensure_display_modes_catalogue()
        assert second['ok'] is True
        assert second['uploaded'] is False
        assert second['reason'] == 'unchanged'
        # No Firestore writes went out for the redundant dispatch.
        mock_rest_client.collection.assert_not_called()

    def test_force_bypasses_cache(self, firebase_client, mock_rest_client, monkeypatch):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        firebase_client._ensure_display_modes_catalogue()
        mock_rest_client.reset_mock()
        forced = firebase_client._ensure_display_modes_catalogue(force=True)
        assert forced['uploaded'] is True
        # set() was invoked on the second call despite the hash being unchanged.
        mock_rest_client.collection.assert_called()

    def test_changed_hash_uploads_again(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        # First call with hash A.
        self._patch_enumerate(monkeypatch, self._canned_result('hash-A'))
        firebase_client._ensure_display_modes_catalogue()
        mock_rest_client.reset_mock()
        # Topology changes — hash B.
        self._patch_enumerate(monkeypatch, self._canned_result('hash-B'))
        second = firebase_client._ensure_display_modes_catalogue()
        assert second['uploaded'] is True
        assert firebase_client._cached_display_modes_hash == 'hash-B'
        mock_rest_client.collection.assert_called()

    def test_enumeration_failed_skips_upload(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        result = self._canned_result()
        result['enumerationFailed'] = True
        result['byEdidHash'] = {}
        self._patch_enumerate(monkeypatch, result)
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is True
        assert out['uploaded'] is False
        assert out['reason'] == 'enumeration_failed'
        mock_rest_client.collection.assert_not_called()

    def test_helper_failure_passes_through(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, {
            'ok': False,
            'error': 'helper spawn failed',
            'code': 'helper_failed',
        })
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is False
        assert out['code'] == 'helper_failed'
        mock_rest_client.collection.assert_not_called()

    def test_skipped_when_disconnected(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.DISCONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is True
        assert out['uploaded'] is False
        assert out['reason'] == 'offline'
        mock_rest_client.collection.assert_not_called()
