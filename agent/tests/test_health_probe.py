"""
Tests for agent/src/health_probe.py

Run with:
    cd agent && pytest tests/test_health_probe.py -v
"""

import json
import os
import socket
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Add src to path so health_probe can be imported directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from health_probe import (
    HealthProbe,
    STATUS_AUTH_ERROR,
    STATUS_CONFIG_ERROR,
    STATUS_NETWORK_ERROR,
    STATUS_OK,
)


def _make_probe(config_path: str, api_base: str = "https://owlette.app/api") -> HealthProbe:
    return HealthProbe(config_path=config_path, api_base=api_base)


class TestConfigCheck(unittest.TestCase):
    """Tests for _check_config()."""

    def test_missing_config_file(self):
        probe = _make_probe("/nonexistent/path/config.json")
        with patch.object(probe, '_check_token_store', return_value=(True, "")), \
             patch.object(probe, '_check_network', return_value=(True, "")):
            result = probe.run()
        self.assertEqual(result.status, STATUS_CONFIG_ERROR)
        self.assertFalse(result.probe_results['config_readable'])

    def test_corrupted_config_file(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write("{not valid json")
            path = f.name
        try:
            probe = _make_probe(path)
            result = probe.run()
            self.assertEqual(result.status, STATUS_CONFIG_ERROR)
            self.assertFalse(result.probe_results['config_readable'])
        finally:
            os.unlink(path)

    def test_config_missing_firebase_section(self):
        config = {"processes": [], "settings": {}}
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config, f)
            path = f.name
        try:
            probe = _make_probe(path)
            result = probe.run()
            self.assertEqual(result.status, STATUS_CONFIG_ERROR)
            self.assertTrue(result.probe_results['config_readable'])
            self.assertFalse(result.probe_results['firebase_section_present'])
        finally:
            os.unlink(path)

    def test_config_with_firebase_section(self):
        config = {"firebase": {"enabled": True, "site_id": "test-site"}}
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config, f)
            path = f.name
        try:
            probe = _make_probe(path)
            with patch.object(probe, '_check_token_store', return_value=(True, "")), \
                 patch.object(probe, '_check_network', return_value=(True, "")):
                result = probe.run()
            self.assertTrue(result.probe_results['config_readable'])
            self.assertTrue(result.probe_results['firebase_section_present'])
        finally:
            os.unlink(path)


class TestTokenStoreCheck(unittest.TestCase):
    """Tests for _check_token_store()."""

    def _valid_config(self):
        config = {"firebase": {"enabled": True, "site_id": "test"}}
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config, f)
            return f.name

    def test_no_refresh_token(self):
        path = self._valid_config()
        try:
            probe = _make_probe(path)
            mock_storage = MagicMock()
            mock_storage.has_refresh_token.return_value = False
            with patch('health_probe.HealthProbe._check_token_store',
                       return_value=(False, "No authentication token found.")):
                with patch.object(probe, '_check_network', return_value=(True, "")):
                    result = probe.run()
            self.assertEqual(result.status, STATUS_AUTH_ERROR)
            self.assertFalse(result.probe_results['token_store_accessible'])
        finally:
            os.unlink(path)

    def test_has_refresh_token(self):
        path = self._valid_config()
        try:
            probe = _make_probe(path)
            with patch('health_probe.HealthProbe._check_token_store',
                       return_value=(True, "")), \
                 patch.object(probe, '_check_network', return_value=(True, "")):
                result = probe.run()
            self.assertTrue(result.probe_results['token_store_accessible'])
        finally:
            os.unlink(path)

    def test_import_error_is_skipped(self):
        """If pywin32/SecureStorage is unavailable, token check should pass (skip)."""
        path = self._valid_config()
        try:
            probe = _make_probe(path)
            with patch('builtins.__import__', side_effect=ImportError("no module")):
                ok, msg = probe._check_token_store()
            # ImportError → skip → return True
            self.assertTrue(ok)
        finally:
            os.unlink(path)


class TestNetworkCheck(unittest.TestCase):
    """Tests for _check_network()."""

    def test_network_reachable(self):
        probe = _make_probe("/unused.json")
        mock_sock = MagicMock()
        with patch('socket.create_connection', return_value=mock_sock):
            ok, msg = probe._check_network()
        self.assertTrue(ok)
        mock_sock.close.assert_called_once()

    def test_network_timeout(self):
        probe = _make_probe("/unused.json")
        with patch('socket.create_connection', side_effect=socket.timeout("timed out")):
            ok, msg = probe._check_network()
        self.assertFalse(ok)
        self.assertIn("reachable", msg.lower())

    def test_network_dns_failure(self):
        probe = _make_probe("/unused.json")
        with patch('socket.create_connection', side_effect=socket.gaierror("name or service not known")):
            ok, msg = probe._check_network()
        self.assertFalse(ok)

    def test_unparseable_host_skips_check(self):
        probe = _make_probe("/unused.json", api_base="")
        ok, msg = probe._check_network()
        # If host can't be parsed, network check is skipped (returns True)
        self.assertTrue(ok)


class TestExtractHost(unittest.TestCase):
    """Tests for _extract_host()."""

    def test_https_url(self):
        probe = _make_probe("/unused.json")
        self.assertEqual(probe._extract_host("https://owlette.app/api"), "owlette.app")

    def test_http_url(self):
        probe = _make_probe("/unused.json")
        self.assertEqual(probe._extract_host("http://localhost:3000/api"), "localhost:3000")

    def test_empty_string(self):
        probe = _make_probe("/unused.json")
        self.assertIsNone(probe._extract_host(""))


class TestFullProbe(unittest.TestCase):
    """Integration-style tests for the full probe run()."""

    def _valid_config_path(self):
        config = {"firebase": {"enabled": True, "site_id": "test"}}
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config, f)
            return f.name

    def test_all_checks_pass_returns_ok(self):
        path = self._valid_config_path()
        try:
            probe = _make_probe(path)
            with patch.object(probe, '_check_token_store', return_value=(True, "")), \
                 patch.object(probe, '_check_network', return_value=(True, "")):
                result = probe.run()
            self.assertEqual(result.status, STATUS_OK)
            self.assertIsNone(result.error_code)
            self.assertTrue(result.is_ok())
            self.assertTrue(all(v is True for v in result.probe_results.values()))
        finally:
            os.unlink(path)

    def test_network_failure_after_auth_ok(self):
        path = self._valid_config_path()
        try:
            probe = _make_probe(path)
            with patch.object(probe, '_check_token_store', return_value=(True, "")), \
                 patch.object(probe, '_check_network', return_value=(False, "Network unreachable")):
                result = probe.run()
            self.assertEqual(result.status, STATUS_NETWORK_ERROR)
            self.assertFalse(result.is_ok())
            self.assertFalse(result.probe_results['network_reachable'])
        finally:
            os.unlink(path)

    def test_to_dict_serialisable(self):
        path = self._valid_config_path()
        try:
            probe = _make_probe(path)
            with patch.object(probe, '_check_token_store', return_value=(True, "")), \
                 patch.object(probe, '_check_network', return_value=(True, "")):
                result = probe.run()
            d = result.to_dict()
            # Must be JSON-serialisable
            json.dumps(d)
            self.assertIn('status', d)
            self.assertIn('probe_results', d)
        finally:
            os.unlink(path)


if __name__ == '__main__':
    unittest.main()
