"""
Unit tests for cortex_cli_fetch — the on-demand Claude Code CLI download.

The 3.0.0 installer strips the SDK's 241.5 MB bundled claude.exe, so
ensure_cli() is the only thing that puts a CLI back on a fresh machine. These
tests cover the whole resolution ladder: sidecar cache hit, pin-mismatch
re-fetch, adoption of an already-matching binary, corrupt-download rejection +
retry, the unverified bundled fallback, the persisted failure backoff, and the
give-up path.

The cache directory is redirected by overriding PROGRAMDATA (shared_utils
resolves it per call), so nothing here touches the real machine's cache.
"""

import hashlib
import json
import os
import time
from unittest.mock import Mock, patch

import pytest

import cortex_cli_fetch


PINNED_SHA = 'a' * 64
OTHER_SHA = 'b' * 64
PINNED_VERSION = '2.1.121'
DOWNLOAD_URL = 'https://storage.googleapis.com/bucket/cortex-cli/claude.exe?X-Goog-Signature=deadbeef'


# Helpers / fixtures

@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    """Point %ProgramData% at a temp dir and return the CLI cache directory."""
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    path = cortex_cli_fetch.get_cache_dir()
    os.makedirs(path, exist_ok=True)
    return path


@pytest.fixture
def no_bundled(monkeypatch):
    """Default: this machine has no SDK-bundled CLI (a fresh 3.0.0 install)."""
    monkeypatch.setattr(cortex_cli_fetch, 'get_bundled_cli_path', lambda: None)


def make_db(doc):
    """Stand-in for FirestoreRestClient returning `doc` from get_document()."""
    db = Mock()
    db.get_document.return_value = doc
    return db


def pinned_doc(version=PINNED_VERSION, sha256=PINNED_SHA, size=1024):
    return {
        'version': version,
        'downloadUrl': DOWNLOAD_URL,
        'sha256': sha256,
        'size': size,
    }


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)


def cli_path(cache_dir):
    return os.path.join(cache_dir, cortex_cli_fetch.CLI_FILENAME)


def sidecar_path(cache_dir):
    return os.path.join(cache_dir, cortex_cli_fetch.SIDECAR_FILENAME)


def state_path(cache_dir):
    return os.path.join(cache_dir, cortex_cli_fetch.FETCH_STATE_FILENAME)


def write_bytes(path, content):
    with open(path, 'wb') as f:
        f.write(content)
    return path


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def write_cli(cache_dir, content=b'cli-bytes'):
    return write_bytes(cli_path(cache_dir), content)


def write_sidecar(cache_dir, path, version=PINNED_VERSION, sha256=PINNED_SHA,
                  size=None, source='download'):
    write_json(sidecar_path(cache_dir), {
        'version': version,
        'sha256': sha256,
        'size': os.path.getsize(path) if size is None else size,
        'path': path,
        'source': source,
        'fetchedAt': int(time.time()),
    })


def fake_download(payload=b'downloaded-cli', relocate_to=None):
    """Build a download_file() stand-in that writes `payload` and succeeds."""
    def _download(url, dest, progress_callback=None, **kwargs):
        target = relocate_to or dest
        write_bytes(target, payload)
        if progress_callback:
            progress_callback(100)
        return True, target
    return _download


# read_pinned_metadata

class TestReadPinnedMetadata:
    """Validation of installer_metadata/cortex_cli."""

    def test_reads_valid_document(self):
        result = cortex_cli_fetch.read_pinned_metadata(make_db(pinned_doc()))
        assert result == {
            'version': PINNED_VERSION,
            'downloadUrl': DOWNLOAD_URL,
            'sha256': PINNED_SHA,
            'size': 1024,
        }

    def test_lowercases_checksum(self):
        result = cortex_cli_fetch.read_pinned_metadata(make_db(pinned_doc(sha256='A' * 64)))
        assert result['sha256'] == 'a' * 64

    def test_reads_the_expected_document_path(self):
        db = make_db(pinned_doc())
        cortex_cli_fetch.read_pinned_metadata(db)
        db.get_document.assert_called_once_with('installer_metadata/cortex_cli')

    def test_none_db_returns_none(self):
        assert cortex_cli_fetch.read_pinned_metadata(None) is None

    def test_missing_document_returns_none(self):
        assert cortex_cli_fetch.read_pinned_metadata(make_db(None)) is None

    def test_read_error_returns_none(self):
        db = Mock()
        db.get_document.side_effect = RuntimeError('offline')
        assert cortex_cli_fetch.read_pinned_metadata(db) is None

    @pytest.mark.parametrize('mutation', [
        {'version': ''},
        {'version': 7},
        {'downloadUrl': 'http://insecure.example/claude.exe'},
        {'downloadUrl': None},
        {'sha256': 'tooshort'},
        {'sha256': 'z' * 64},
    ])
    def test_malformed_document_returns_none(self, mutation):
        doc = pinned_doc()
        doc.update(mutation)
        assert cortex_cli_fetch.read_pinned_metadata(make_db(doc)) is None

    def test_missing_size_is_optional(self):
        doc = pinned_doc()
        del doc['size']
        result = cortex_cli_fetch.read_pinned_metadata(make_db(doc))
        assert result is not None
        assert result['size'] is None


# Cache hit

class TestCacheHit:
    """The happy path: an already-verified binary is reused untouched."""

    def test_returns_cached_binary_without_downloading(self, cache_dir, no_bundled):
        cli = write_cli(cache_dir)
        write_sidecar(cache_dir, cli)

        with patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == cli
        mock_download.assert_not_called()

    def test_does_not_rehash_the_cached_binary(self, cache_dir, no_bundled):
        cli = write_cli(cache_dir)
        write_sidecar(cache_dir, cli)

        with patch('installer_utils.verify_checksum') as mock_verify:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == cli
        mock_verify.assert_not_called()

    def test_offline_metadata_still_uses_verified_cache(self, cache_dir, no_bundled):
        cli = write_cli(cache_dir)
        write_sidecar(cache_dir, cli)

        db = Mock()
        db.get_document.side_effect = RuntimeError('no network')

        with patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(db)

        assert result == cli
        mock_download.assert_not_called()

    def test_size_drift_invalidates_the_cache(self, cache_dir):
        cli = write_cli(cache_dir)
        write_sidecar(cache_dir, cli, size=os.path.getsize(cli) + 1)
        pinned = cortex_cli_fetch.read_pinned_metadata(make_db(pinned_doc()))

        assert cortex_cli_fetch._sidecar_binary(read_json(sidecar_path(cache_dir)), pinned) is None

    def test_deleted_binary_invalidates_the_cache(self, cache_dir):
        cli = write_cli(cache_dir)
        write_sidecar(cache_dir, cli)
        os.remove(cli)

        assert cortex_cli_fetch._sidecar_binary(read_json(sidecar_path(cache_dir)), None) is None

    def test_malformed_sidecar_is_ignored(self, cache_dir):
        assert cortex_cli_fetch._sidecar_binary({'path': 123}, None) is None
        assert cortex_cli_fetch._sidecar_binary({}, None) is None
        assert cortex_cli_fetch._sidecar_binary(None, None) is None


# Version mismatch → re-fetch

class TestVersionMismatchRefetch:
    """A moved pin must invalidate the cache and pull the new build."""

    def test_pin_change_triggers_download(self, cache_dir, no_bundled):
        cli = write_cli(cache_dir, b'old-cli')
        write_sidecar(cache_dir, cli, version='2.1.100', sha256=OTHER_SHA)

        with patch('installer_utils.download_file',
                   side_effect=fake_download(b'new-cli')) as mock_download, \
             patch('installer_utils.verify_checksum',
                   side_effect=lambda path, expected: read_bytes(path) == b'new-cli'):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == cli_path(cache_dir)
        mock_download.assert_called_once()
        assert read_bytes(result) == b'new-cli'

        sidecar = read_json(sidecar_path(cache_dir))
        assert sidecar['version'] == PINNED_VERSION
        assert sidecar['sha256'] == PINNED_SHA
        assert sidecar['source'] == 'download'
        assert sidecar['size'] == len(b'new-cli')

    def test_stale_cached_binary_is_adopted_when_it_matches_the_new_pin(self, cache_dir, no_bundled):
        """Sidecar says 2.1.100 but the bytes are already the pinned build."""
        payload = b'already-the-pinned-build'
        cli = write_cli(cache_dir, payload)
        write_sidecar(cache_dir, cli, version='2.1.100', sha256=OTHER_SHA)
        real_sha = hashlib.sha256(payload).hexdigest()

        with patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc(sha256=real_sha)))

        assert result == cli
        mock_download.assert_not_called()
        assert read_json(sidecar_path(cache_dir))['sha256'] == real_sha

    def test_download_uses_the_returned_path_not_the_requested_one(self, cache_dir, no_bundled):
        """download_file relocates the target when it is locked — honour that."""
        relocated = os.path.join(cache_dir, 'claude.exe.part_1700000000')

        with patch('installer_utils.download_file',
                   side_effect=fake_download(b'relocated-cli', relocate_to=relocated)), \
             patch('installer_utils.verify_checksum', return_value=True):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == cli_path(cache_dir)
        assert not os.path.exists(relocated)
        assert read_bytes(result) == b'relocated-cli'


# Corrupt download / corrupt cache

class TestChecksumRejection:
    """Complete-but-corrupt bytes must be discarded, then retried once."""

    def test_corrupt_download_is_rejected_and_retried(self, cache_dir, no_bundled):
        attempts = {'n': 0}

        def _download(url, dest, progress_callback=None, **kwargs):
            attempts['n'] += 1
            write_bytes(dest, b'corrupt' if attempts['n'] == 1 else b'good')
            return True, dest

        def _verify(path, expected):
            return read_bytes(path) == b'good'

        with patch('installer_utils.download_file', side_effect=_download), \
             patch('installer_utils.verify_checksum', side_effect=_verify):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert attempts['n'] == 2
        assert result == cli_path(cache_dir)
        assert read_bytes(result) == b'good'

    def test_corrupt_download_is_deleted_not_installed(self, cache_dir, no_bundled):
        with patch('installer_utils.download_file', side_effect=fake_download(b'corrupt')), \
             patch('installer_utils.verify_checksum', return_value=False):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result is None
        assert not os.path.exists(cli_path(cache_dir))
        assert not os.path.exists(os.path.join(cache_dir, cortex_cli_fetch.PARTIAL_FILENAME))

    def test_persistent_corruption_gives_up_after_max_attempts(self, cache_dir, no_bundled):
        attempts = {'n': 0}

        def _download(url, dest, progress_callback=None, **kwargs):
            attempts['n'] += 1
            write_bytes(dest, b'corrupt')
            return True, dest

        with patch('installer_utils.download_file', side_effect=_download), \
             patch('installer_utils.verify_checksum', return_value=False):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result is None
        assert attempts['n'] == cortex_cli_fetch.MAX_DOWNLOAD_ATTEMPTS

    def test_corrupted_cache_with_lost_sidecar_is_rejected_and_refetched(self, cache_dir, no_bundled):
        """The live-machine scenario: flip a byte, invalidate the sidecar."""
        payload = b'the-pinned-build'
        real_sha = hashlib.sha256(payload).hexdigest()
        write_cli(cache_dir, b'the-p1nned-build')  # one byte flipped, no sidecar

        def _verify(path, expected):
            return hashlib.sha256(read_bytes(path)).hexdigest() == expected

        with patch('installer_utils.download_file', side_effect=fake_download(payload)) as mock_download, \
             patch('installer_utils.verify_checksum', side_effect=_verify):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc(sha256=real_sha)))

        mock_download.assert_called_once()
        assert result == cli_path(cache_dir)
        assert read_bytes(result) == payload
        assert read_json(sidecar_path(cache_dir))['sha256'] == real_sha


# Bundled copy

class TestBundledCli:
    """In-place 2.x upgrades still carry the SDK's binary."""

    @pytest.fixture
    def bundled(self, tmp_path, monkeypatch):
        path = tmp_path / 'sdk' / '_bundled' / 'claude.exe'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'bundled-bytes')
        monkeypatch.setattr(cortex_cli_fetch, 'get_bundled_cli_path', lambda: str(path))
        return str(path)

    def test_matching_bundled_copy_is_adopted_without_downloading(self, cache_dir, bundled):
        with patch('installer_utils.verify_checksum', return_value=True), \
             patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == bundled
        mock_download.assert_not_called()

        sidecar = read_json(sidecar_path(cache_dir))
        assert sidecar['source'] == 'bundled'
        assert sidecar['path'] == bundled

    def test_adopted_bundled_copy_is_a_cache_hit_next_start(self, cache_dir, bundled):
        with patch('installer_utils.verify_checksum', return_value=True):
            cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        with patch('installer_utils.verify_checksum') as mock_verify, \
             patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == bundled
        mock_verify.assert_not_called()
        mock_download.assert_not_called()

    def test_mismatched_bundled_copy_falls_through_to_download(self, cache_dir, bundled):
        with patch('installer_utils.verify_checksum',
                   side_effect=lambda path, expected: path != bundled), \
             patch('installer_utils.download_file',
                   side_effect=fake_download(b'pinned')) as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        mock_download.assert_called_once()
        assert result == cli_path(cache_dir)

    def test_bundled_copy_rescues_a_failed_fetch(self, cache_dir, bundled):
        with patch('installer_utils.verify_checksum', return_value=False), \
             patch('installer_utils.download_file', return_value=(False, '')):
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert result == bundled

    def test_bundled_copy_rescues_unreadable_metadata(self, cache_dir, bundled):
        with patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(None))

        assert result == bundled
        mock_download.assert_not_called()

    def test_cached_binary_wins_over_bundled_in_the_fallback(self, cache_dir, bundled):
        """Unreadable metadata + lost sidecar: the cache was verified once, prefer it."""
        cli = write_cli(cache_dir)

        with patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(None))

        assert result == cli
        mock_download.assert_not_called()

    def test_locates_the_sdk_bundled_path(self, tmp_path, monkeypatch):
        package = tmp_path / 'claude_agent_sdk'
        (package / '_bundled').mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / '_bundled' / 'claude.exe').write_bytes(b'x')

        fake_module = Mock()
        fake_module.__file__ = str(package / '__init__.py')
        with patch.dict('sys.modules', {'claude_agent_sdk': fake_module}):
            assert cortex_cli_fetch.get_bundled_cli_path() == str(package / '_bundled' / 'claude.exe')

    def test_absent_bundled_path_returns_none(self, tmp_path):
        fake_module = Mock()
        fake_module.__file__ = str(tmp_path / 'claude_agent_sdk' / '__init__.py')
        with patch.dict('sys.modules', {'claude_agent_sdk': fake_module}):
            assert cortex_cli_fetch.get_bundled_cli_path() is None


# Failure handling / backoff

class TestFailurePath:
    """No CLI anywhere: return None quietly and throttle the retries."""

    def test_returns_none_when_everything_fails(self, cache_dir, no_bundled):
        with patch('installer_utils.download_file', return_value=(False, '')):
            assert cortex_cli_fetch.ensure_cli(make_db(pinned_doc())) is None

    def test_missing_metadata_returns_none(self, cache_dir, no_bundled):
        assert cortex_cli_fetch.ensure_cli(make_db(None)) is None

    def test_missing_metadata_uses_an_unverified_cached_binary(self, cache_dir, no_bundled):
        cli = write_cli(cache_dir)
        assert cortex_cli_fetch.ensure_cli(make_db(None)) == cli

    def test_failure_is_recorded_for_backoff(self, cache_dir, no_bundled):
        with patch('installer_utils.download_file', return_value=(False, '')):
            cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        state = read_json(state_path(cache_dir))
        assert state['consecutiveFailures'] == 1
        assert state['lastFailureAt'] > 0

    def test_backoff_suppresses_the_next_download(self, cache_dir, no_bundled):
        with patch('installer_utils.download_file', return_value=(False, '')) as mock_download:
            cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))
            assert mock_download.call_count == 1
            # The service relaunches Cortex 30 s later — must not re-download.
            assert cortex_cli_fetch.ensure_cli(make_db(pinned_doc())) is None
            assert mock_download.call_count == 1

    def test_backoff_expires(self, cache_dir):
        cortex_cli_fetch._record_fetch_failure('boom')
        assert cortex_cli_fetch._fetch_backoff_remaining() > 0

        state = read_json(state_path(cache_dir))
        state['lastFailureAt'] = time.time() - cortex_cli_fetch.FETCH_BACKOFF_BASE_SECONDS - 1
        write_json(state_path(cache_dir), state)

        assert cortex_cli_fetch._fetch_backoff_remaining() == 0

    def test_backoff_grows_then_caps(self, cache_dir):
        for _ in range(cortex_cli_fetch.MAX_TRACKED_FAILURES + 4):
            cortex_cli_fetch._record_fetch_failure('boom')

        state = read_json(state_path(cache_dir))
        assert state['consecutiveFailures'] == cortex_cli_fetch.MAX_TRACKED_FAILURES
        assert 0 < cortex_cli_fetch._fetch_backoff_remaining() <= cortex_cli_fetch.FETCH_BACKOFF_MAX_SECONDS

    def test_future_timestamp_does_not_wedge_the_backoff(self, cache_dir):
        cortex_cli_fetch._record_fetch_failure('boom')
        state = read_json(state_path(cache_dir))
        state['lastFailureAt'] = time.time() + 10_000
        write_json(state_path(cache_dir), state)

        assert cortex_cli_fetch._fetch_backoff_remaining() == 0

    def test_success_clears_the_failure_state(self, cache_dir, no_bundled):
        cortex_cli_fetch._record_fetch_failure('boom')
        state = read_json(state_path(cache_dir))
        state['lastFailureAt'] = 1.0  # long expired
        write_json(state_path(cache_dir), state)

        with patch('installer_utils.download_file', side_effect=fake_download(b'good')), \
             patch('installer_utils.verify_checksum', return_value=True):
            assert cortex_cli_fetch.ensure_cli(make_db(pinned_doc())) is not None

        assert not os.path.exists(state_path(cache_dir))

    def test_insufficient_disk_space_aborts_before_downloading(self, cache_dir, no_bundled):
        with patch('cortex_cli_fetch.shutil.disk_usage',
                   return_value=Mock(free=10 * 1024 * 1024)), \
             patch('installer_utils.download_file') as mock_download:
            result = cortex_cli_fetch.ensure_cli(make_db(pinned_doc(size=500 * 1024 * 1024)))

        assert result is None
        mock_download.assert_not_called()

    def test_unknown_size_skips_the_disk_space_guard(self, cache_dir, no_bundled):
        doc = pinned_doc()
        del doc['size']

        with patch('cortex_cli_fetch.shutil.disk_usage', return_value=Mock(free=1)), \
             patch('installer_utils.download_file', side_effect=fake_download(b'good')), \
             patch('installer_utils.verify_checksum', return_value=True):
            assert cortex_cli_fetch.ensure_cli(make_db(doc)) == cli_path(cache_dir)


# Logging hygiene

class TestLoggingHygiene:
    """Signed URLs carry a signature — it must never reach cortex.log."""

    def test_redacts_the_query_string(self):
        redacted = cortex_cli_fetch._redact_url(DOWNLOAD_URL)
        assert redacted == 'https://storage.googleapis.com/bucket/cortex-cli/claude.exe'
        assert 'deadbeef' not in redacted

    def test_redacts_garbage_input(self):
        assert cortex_cli_fetch._redact_url('not a url') == '<url>'

    def test_download_log_lines_carry_no_signature(self, cache_dir, no_bundled, caplog):
        with caplog.at_level('INFO'), \
             patch('installer_utils.download_file', return_value=(False, '')):
            cortex_cli_fetch.ensure_cli(make_db(pinned_doc()))

        assert 'deadbeef' not in caplog.text
        assert 'X-Goog-Signature' not in caplog.text
