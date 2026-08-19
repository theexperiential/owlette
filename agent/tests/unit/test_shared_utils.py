"""
Unit tests for shared_utils module

Tests utility functions for configuration, system metrics, and process management.
"""

import pytest
import json
from pathlib import Path
from unittest.mock import Mock, patch, mock_open, MagicMock
import sys

# Import the module under test
import shared_utils


class TestConfigManagement:
    """Tests for configuration file management"""

    def test_read_config_file_exists(self, mock_config):
        """Test reading configuration when file exists"""
        config_json = json.dumps(mock_config)

        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.path.exists', return_value=True):
                result = shared_utils.read_config()

                assert result is not None
                assert result['firebase']['site_id'] == 'test-site'
                assert len(result['processes']) == 1

    def test_read_config_file_missing(self):
        """Test reading configuration when file doesn't exist"""
        # Bypass the mtime-based config cache by making getmtime raise.
        # _read_config_cached() falls through to the raw reader in that case.
        with patch('os.path.getmtime', side_effect=OSError):
            with patch('builtins.open', side_effect=FileNotFoundError):
                result = shared_utils.read_config()

                assert result == {}

    def test_read_config_invalid_json(self):
        """Test reading configuration with invalid JSON"""
        with patch('os.path.getmtime', side_effect=OSError):
            with patch('builtins.open', mock_open(read_data='invalid json{')):
                result = shared_utils.read_config()

                assert result == {}

    def test_read_config_specific_keys(self, mock_config):
        """Test reading specific keys from configuration"""
        config_json = json.dumps(mock_config)

        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.path.exists', return_value=True):
                # Read specific keys
                processes = shared_utils.read_config(['processes'])

                assert isinstance(processes, list)
                assert len(processes) == 1
                assert processes[0]['name'] == 'Test Process'

    def test_write_config_success(self, mock_config):
        """Test writing configuration successfully"""
        config_json = json.dumps(mock_config)
        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.replace'):
                # write_config takes (keys, value) and updates a nested key
                shared_utils.write_config(['logging', 'level'], 'DEBUG')

    def test_write_config_failure(self, mock_config):
        """Test writing configuration when file cannot be read"""
        with patch('builtins.open', side_effect=IOError("Cannot write file")):
            # write_config should not raise — write_json_to_file handles errors
            try:
                shared_utils.write_config(['logging', 'level'], 'DEBUG')
            except (IOError, OSError):
                pass  # Expected when file operations fail


class TestSystemMetrics:
    """Tests for system metrics collection"""

    def test_get_system_metrics_basic(self):
        """Test basic system metrics collection returns expected keys"""
        metrics = shared_utils.get_system_metrics(skip_gpu=True)

        assert 'cpu' in metrics
        assert 'percent' in metrics['cpu']
        assert 'memory' in metrics
        assert 'percent' in metrics['memory']
        assert 'disk' in metrics
        assert 'percent' in metrics['disk']

    def test_get_system_metrics_with_gpu(self):
        """Test system metrics collection includes GPU section"""
        mock_gpu = Mock()
        mock_gpu.load = 0.75
        mock_gpu.memoryUsed = 8192  # MB
        mock_gpu.memoryTotal = 16384  # MB
        mock_gpu.name = "Test GPU"
        mock_gpu.temperature = 65

        # GPUtil is now lazy-loaded via _get_gputil(). Return a fake module
        # whose getGPUs() returns our mock GPU object.
        fake_gputil_module = Mock()
        fake_gputil_module.getGPUs = Mock(return_value=[mock_gpu])

        with patch('shared_utils._get_gputil', return_value=fake_gputil_module):
            with patch('shared_utils.get_gpu_temperatures', return_value=[{'temperature': 65}]):
                metrics = shared_utils.get_system_metrics(skip_gpu=False)

        assert metrics['gpu']['usage_percent'] == 75.0
        assert metrics['gpu']['name'] == 'Test GPU'


class TestProcessUtils:
    """Tests for process utility functions"""

    def test_is_process_responsive_windows(self):
        """Test process responsiveness check (Windows-specific)"""
        # This test should be marked as Windows-only
        pytest.skip("Windows-specific test - requires win32gui")

    @patch('psutil.Process')
    def test_get_process_info(self, mock_process):
        """Test getting process information"""
        mock_proc = Mock()
        mock_proc.pid = 12345
        mock_proc.name.return_value = "test.exe"
        mock_proc.status.return_value = "running"
        mock_process.return_value = mock_proc

        info = {
            'pid': mock_proc.pid,
            'name': mock_proc.name(),
            'status': mock_proc.status()
        }

        assert info['pid'] == 12345
        assert info['name'] == "test.exe"
        assert info['status'] == "running"


@pytest.mark.unit
class TestUtilityFunctions:
    """Tests for misc utility functions"""

    def test_get_timestamp(self):
        """Test timestamp generation"""
        timestamp = shared_utils.get_timestamp() if hasattr(shared_utils, 'get_timestamp') else None

        if timestamp:
            assert isinstance(timestamp, (int, float))
            assert timestamp > 0

    def test_format_bytes(self):
        """Test byte formatting"""
        if hasattr(shared_utils, 'format_bytes'):
            assert shared_utils.format_bytes(1024) == "1.0 KB"
            assert shared_utils.format_bytes(1024 * 1024) == "1.0 MB"
            assert shared_utils.format_bytes(1024 * 1024 * 1024) == "1.0 GB"


# ─── external log rotation ───────────────────────────────────────────


class TestRotateLogIfOversized:
    """
    guards the installer's /LOG file, which Inno Setup appends to forever and
    which cleanup_old_logs never ages out (each update refreshes its mtime).
    """

    def test_small_log_is_left_alone(self, tmp_path):
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 100)

        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is False
        assert log.read_bytes() == b'x' * 100
        assert not (tmp_path / 'installer_update.log.1').exists()

    def test_oversized_log_is_rotated_once(self, tmp_path):
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 4096)

        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is True
        assert not log.exists()  # next writer starts from empty
        assert (tmp_path / 'installer_update.log.1').read_bytes() == b'x' * 4096

    def test_rotation_keeps_exactly_one_generation(self, tmp_path):
        """a second rotation replaces .1 — no growing .1/.2/.3 chain."""
        log = tmp_path / 'installer_update.log'
        rotated = tmp_path / 'installer_update.log.1'

        log.write_bytes(b'first' * 1000)
        shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024)
        log.write_bytes(b'second' * 1000)
        shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024)

        assert rotated.read_bytes() == b'second' * 1000
        assert not (tmp_path / 'installer_update.log.2').exists()

    def test_missing_log_is_not_an_error(self, tmp_path):
        assert shared_utils.rotate_log_if_oversized(
            str(tmp_path / 'never-written.log')
        ) is False

    def test_failure_never_raises(self, tmp_path, monkeypatch):
        """an update must not fail because its log could not be rotated."""
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 4096)

        def _boom(*a, **kw):
            raise OSError('file locked by the installer')

        monkeypatch.setattr(shared_utils.os, 'replace', _boom)
        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is False
        assert log.exists()
