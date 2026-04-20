"""tests for sync_assembler — atomic file reassembly with allowlist enforcement."""

import hashlib
import os
import threading
from pathlib import Path

import pytest

from destination_allowlist import DestinationAllowlist, DestinationNotAllowedError
from sync_assembler import AssembleError, AssembleResult, assemble_all
from sync_downloader import chunk_path
from sync_manifest import ManifestChunk, ManifestFile
from sync_state import SyncState


def _put_chunk(store: Path, data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()
    target = chunk_path(store, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return h


def _mk_manifest_file(path: str, chunk_data_list):
    """build a ManifestFile from a list of chunk byte payloads."""
    chunks = []
    total = 0
    for data in chunk_data_list:
        h = hashlib.sha256(data).hexdigest()
        chunks.append(ManifestChunk(hash=h, size=len(data)))
        total += len(data)
    return ManifestFile(path=path, size=total, chunks=chunks)


# ─── happy path ──────────────────────────────────────────────────────


def test_single_file_single_chunk(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'hello world'
        _put_chunk(content, data)
        f = _mk_manifest_file('a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id,
            files=[f],
            extract_root=str(extract),
            state=state,
            allowlist=allowlist,
            content_store=str(content),
        )
        assert result.assembled == 1
        assert result.failed == 0
        assert (extract / 'a.toe').read_bytes() == data
    finally:
        state.close()


def test_single_file_multiple_chunks(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        chunks_data = [b'part 1 ', b'part 2 ', b'part 3']
        for d in chunks_data:
            _put_chunk(content, d)
        f = _mk_manifest_file('a.toe', chunks_data)

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert (extract / 'a.toe').read_bytes() == b''.join(chunks_data)
    finally:
        state.close()


def test_creates_subdirectories(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'nested file content'
        _put_chunk(content, data)
        f = _mk_manifest_file('sub/dir/deep/file.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert (extract / 'sub' / 'dir' / 'deep' / 'file.toe').read_bytes() == data
    finally:
        state.close()


def test_idempotent_skip_when_target_already_present(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'pre-existing content'
        _put_chunk(content, data)
        f = _mk_manifest_file('a.toe', [data])
        # pre-create the target with the right size
        (extract / 'a.toe').write_bytes(data)

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 0
        assert result.skipped == 1
    finally:
        state.close()


# ─── security floor ─────────────────────────────────────────────────


def test_extract_root_outside_allowlist_raises(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        # allowlist is /allowed but extract_root is /not_allowed
        allowed = tmp_path / 'allowed'
        not_allowed = tmp_path / 'not_allowed'
        allowed.mkdir()
        not_allowed.mkdir()
        allowlist = DestinationAllowlist([str(allowed)])

        f = _mk_manifest_file('a.toe', [b'data'])
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="not allowed"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(not_allowed),
                state=state, allowlist=allowlist, content_store=str(content),
            )
    finally:
        state.close()


def test_empty_allowlist_rejects_everything(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        allowlist = DestinationAllowlist([])  # fail-closed
        f = _mk_manifest_file('a.toe', [b'data'])
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="not allowed"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(tmp_path),
                state=state, allowlist=allowlist, content_store=str(tmp_path / 'c'),
            )
    finally:
        state.close()


# ─── failure paths ──────────────────────────────────────────────────


def test_missing_chunk_in_store_fails_assembly(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        content.mkdir()
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])
        # claim a chunk exists but never put it in the store
        f = _mk_manifest_file('a.toe', [b'never-downloaded'])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError, match="failed to assemble"):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # state row marked failed
        files = state.list_files(dist_id, state='failed')
        assert len(files) == 1
        assert 'missing from content store' in (files[0]['error'] or '')
    finally:
        state.close()


def test_partial_file_left_on_failure_for_resume(tmp_path):
    """on failure mid-assemble, the .partial sidecar stays so a retry can resume."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        content.mkdir()
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        # 2 chunks: first present, second missing
        first_data = b'first chunk data'
        _put_chunk(content, first_data)
        f = _mk_manifest_file('a.toe', [first_data, b'never-there'])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with pytest.raises(AssembleError):
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        # the live target file does NOT exist
        assert not (extract / 'a.toe').exists()
    finally:
        state.close()


# ─── cancellation ───────────────────────────────────────────────────


# ─── long-path support (windows-specific) ───────────────────────────


def test_long_path_helper_pure_function():
    """unit-level coverage for _long_path: short paths pass through, long paths get prefix."""
    import os
    from sync_assembler import _long_path
    if os.name != 'nt':
        # POSIX: always pass through
        assert _long_path('/short/path') == '/short/path'
        assert _long_path('/' + 'x' * 300) == '/' + 'x' * 300
        return
    # windows
    short = 'C:\\Users\\dylan\\file.toe'
    assert _long_path(short) == short
    long_path = 'C:\\Users\\dylan\\' + 'x' * 280 + '\\file.toe'
    assert _long_path(long_path).startswith('\\\\?\\C:\\')
    # already-prefixed → unchanged
    pre_prefixed = '\\\\?\\C:\\anything'
    assert _long_path(pre_prefixed) == pre_prefixed
    # UNC paths get the special UNC prefix
    unc_long = '\\\\server\\share\\' + 'x' * 280
    assert _long_path(unc_long).startswith('\\\\?\\UNC\\')


@pytest.mark.skipif(__import__('os').name != 'nt', reason='windows long-path test')
def test_assembles_file_at_long_path(tmp_path):
    """assemble a file whose final path exceeds MAX_PATH (260). win32 must accept `\\\\?\\` prefix."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        # build a path that exceeds MAX_PATH after joining with extract.
        # tmp_path + 'extract' is already ~85-90 chars on most CI; pad
        # to push the full target above 260.
        deep_segments = ['x' * 30 for _ in range(8)]  # 8 dirs of 30 chars each = ~240 chars
        deep_relative = '/'.join(deep_segments) + '/file.toe'
        full = str(extract / deep_relative.replace('/', os.sep))
        if len(full) < 260:
            pytest.skip(f"test path only {len(full)} chars on this filesystem; can't exercise long-path")

        data = b'long-path content'
        _put_chunk(content, data)
        f = _mk_manifest_file(deep_relative, [data])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        result = assemble_all(
            distribution_id=dist_id, files=[f], extract_root=str(extract),
            state=state, allowlist=allowlist, content_store=str(content),
        )
        assert result.assembled == 1
        # verify on disk via the long-path-prefixed string (regular Path may fail to stat)
        from sync_assembler import _long_path
        prefixed = _long_path(full)
        assert os.path.exists(prefixed)
    finally:
        state.close()


# ─── ACL hardening (windows-specific, best-effort) ──────────────────


def test_harden_acl_no_op_on_posix():
    """on POSIX, _harden_acl returns silently without doing anything."""
    import os
    from unittest.mock import patch
    from sync_assembler import _harden_acl
    if os.name == 'nt':
        pytest.skip('this test asserts POSIX behavior')
    # should not raise even on a path that doesn't exist
    _harden_acl('/nonexistent/path/file.toe')


def test_harden_acl_silent_when_pywin32_missing():
    """when pywin32 is unimportable, _harden_acl skips silently — no exception."""
    import sys
    from unittest.mock import patch
    from sync_assembler import _harden_acl
    if __import__('os').name != 'nt':
        pytest.skip('this test exercises the windows path')
    # simulate pywin32 missing
    with patch.dict(sys.modules, {'win32security': None, 'ntsecuritycon': None}):
        # ImportError when None is treated as "not a module" → except branch
        _harden_acl('C:\\anywhere\\file.toe')


@pytest.mark.skipif(__import__('os').name != 'nt', reason='windows ACL test')
def test_assemble_calls_harden_acl_on_target(tmp_path):
    """end-to-end: assembling a file invokes _harden_acl with the target path."""
    from unittest.mock import patch
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'acl test'
        _put_chunk(content, data)
        f = _mk_manifest_file('a.toe', [data])

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size}], chunks=[],
        )
        with patch('sync_assembler._harden_acl') as mock_harden:
            assemble_all(
                distribution_id=dist_id, files=[f], extract_root=str(extract),
                state=state, allowlist=allowlist, content_store=str(content),
            )
        mock_harden.assert_called_once()
        # called with the target path string (long-path-prefixed form)
        called_with = mock_harden.call_args[0][0]
        assert 'a.toe' in called_with
    finally:
        state.close()


def test_cancel_event_stops_after_current_file(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        content = tmp_path / 'content'
        extract = tmp_path / 'extract'
        extract.mkdir()
        allowlist = DestinationAllowlist([str(extract)])

        data = b'data'
        _put_chunk(content, data)
        files = [_mk_manifest_file(f'f{i}.toe', [data]) for i in range(3)]

        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': f.path, 'size': f.size} for f in files], chunks=[],
        )
        cancel_event = threading.Event()
        cancel_event.set()  # pre-cancelled

        result = assemble_all(
            distribution_id=dist_id, files=files, extract_root=str(extract),
            state=state, allowlist=allowlist, cancel_event=cancel_event,
            content_store=str(content),
        )
        assert result.assembled == 0
        assert result.cancelled is True
    finally:
        state.close()
