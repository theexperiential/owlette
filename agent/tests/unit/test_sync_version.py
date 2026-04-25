"""tests for sync_version — fetch + cache + diff + validate."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sync_version import (
    VERSION_MEDIA_TYPE,
    VERSION_SCHEMA_VERSION,
    Version,
    VersionChunk,
    VersionError,
    VersionFile,
    diff_versions,
    fetch_version,
)


def _valid_version_json(files=None):
    """build a minimal valid version dict for tests."""
    return {
        'schemaVersion': VERSION_SCHEMA_VERSION,
        'mediaType': VERSION_MEDIA_TYPE,
        'config': {
            'name': 'test-roost',
            'createdAt': '2026-04-19T00:00:00Z',
            'createdBy': 'test',
            'siteId': 'site_test',
            'roostId': 'roost_test',
        },
        'files': files or [
            {
                'path': 'a.toe',
                'size': 100,
                'chunks': [{'hash': 'a' * 64, 'size': 100}],
            },
        ],
    }


# ─── parse + validate ───────────────────────────────────────────────


def test_valid_version_parses(tmp_path):
    raw = json.dumps(_valid_version_json()).encode('utf-8')
    cache_path = tmp_path / 'versions'
    with patch('sync_version._http_fetch', return_value=raw):
        m = fetch_version('http://example/m.json', expected_version_id='m1', cache_dir=str(cache_path))
    assert m.schema_version == 2
    assert len(m.files) == 1
    assert m.files[0].path == 'a.toe'
    assert m.total_size == 100


def test_unsupported_schema_version_rejected():
    body = _valid_version_json()
    body['schemaVersion'] = 999
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="schemaVersion"):
            fetch_version('http://example/m.json')


def test_wrong_media_type_rejected():
    body = _valid_version_json()
    body['mediaType'] = 'application/json'
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="mediaType"):
            fetch_version('http://example/m.json')


def test_path_with_dotdot_rejected():
    body = _valid_version_json(files=[
        {'path': '../etc/evil', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_absolute_path_rejected():
    body = _valid_version_json(files=[
        {'path': '/etc/passwd', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_backslash_traversal_rejected():
    """windows-style traversal with backslash separators — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': '..\\etc\\evil', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_mixed_traversal_rejected():
    """path like `foo/../../bar` — survives segment split — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': 'foo/../../bar', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_windows_drive_absolute_rejected():
    """`C:/foo` or `C:\\foo` — rejected — wave 4b.2."""
    for path_val in ('C:/foo.toe', 'C:\\foo.toe', 'D:relative.toe'):
        body = _valid_version_json(files=[
            {'path': path_val, 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
        ])
        raw = json.dumps(body).encode('utf-8')
        with patch('sync_version._http_fetch', return_value=raw):
            with pytest.raises(VersionError, match="path constraints"):
                fetch_version('http://example/m.json')


def test_null_byte_rejected():
    """NUL byte anywhere in path — rejected — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': 'inno\x00cent.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_dot_segment_rejected():
    """path with `.` segment — rejected (non-canonical) — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': 'a/./b.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_empty_segment_rejected():
    """path with `//` — rejected (non-canonical) — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': 'a//b.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_ads_colon_in_segment_rejected():
    """windows alternate data stream syntax (`file.toe:hidden`) — rejected — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': 'a/file.toe:hidden', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_unc_path_rejected():
    """UNC-style path `\\\\server\\share\\foo` — starts with separator — rejected — wave 4b.2."""
    body = _valid_version_json(files=[
        {'path': '\\\\server\\share\\foo.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="path constraints"):
            fetch_version('http://example/m.json')


def test_unicode_double_dot_lookalike_allowed():
    """
    cve-2025-4330 regression — unicode lookalike (U+2025 TWO DOT LEADER) is
    NOT `..`. the parser rejects literal `..` not visually similar glyphs;
    the real defense against exotic unicode escaping is realpath enforcement
    in destination_allowlist (at write time). confirm the parser doesn't
    false-positive and drop legit unicode filenames.
    """
    body = _valid_version_json(files=[
        {'path': 'docs/‥note.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        version = fetch_version('http://example/m.json')
        assert version.files[0].path == 'docs/‥note.toe'


def test_uppercase_hash_rejected():
    body = _valid_version_json(files=[
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'A' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="lowercase"):
            fetch_version('http://example/m.json')


def test_chunk_size_sum_must_equal_file_size():
    body = _valid_version_json(files=[
        {'path': 'a.toe', 'size': 200,  # claims 200 but chunk only 100
         'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="sum"):
            fetch_version('http://example/m.json')


def test_duplicate_path_rejected():
    body = _valid_version_json(files=[
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'b' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw):
        with pytest.raises(VersionError, match="duplicated"):
            fetch_version('http://example/m.json')


def test_invalid_json_rejected():
    with patch('sync_version._http_fetch', return_value=b'{not valid json'):
        with pytest.raises(VersionError, match="json"):
            fetch_version('http://example/m.json')


# ─── cache ───────────────────────────────────────────────────────────


def test_cache_hit_skips_http(tmp_path):
    cache_dir = tmp_path / 'versions'
    cache_dir.mkdir(parents=True)
    raw = json.dumps(_valid_version_json()).encode('utf-8')
    (cache_dir / 'm1.json').write_bytes(raw)

    fake_fetch = MagicMock()
    with patch('sync_version._http_fetch', fake_fetch):
        m = fetch_version('http://example/m.json', expected_version_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 0
    assert len(m.files) == 1


def test_cache_miss_fetches_and_writes_cache(tmp_path):
    cache_dir = tmp_path / 'versions'
    raw = json.dumps(_valid_version_json()).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw) as fake_fetch:
        m = fetch_version('http://example/m.json', expected_version_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 1
    cached = cache_dir / 'm1.json'
    assert cached.exists()
    assert cached.read_bytes() == raw


def test_corrupt_cache_falls_through_to_fetch(tmp_path):
    cache_dir = tmp_path / 'versions'
    cache_dir.mkdir(parents=True)
    (cache_dir / 'm1.json').write_bytes(b'corrupt garbage')
    raw = json.dumps(_valid_version_json()).encode('utf-8')
    with patch('sync_version._http_fetch', return_value=raw) as fake_fetch:
        m = fetch_version('http://example/m.json', expected_version_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 1
    assert len(m.files) == 1


# ─── diff ────────────────────────────────────────────────────────────


def _mk_version(files):
    """build a Version in-memory (without parsing JSON)."""
    return Version(
        schema_version=2,
        media_type=VERSION_MEDIA_TYPE,
        config={},
        files=files,
        raw_bytes=b'',
    )


def test_diff_first_install_marks_everything_added():
    new = _mk_version([
        VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)]),
    ])
    diff = diff_versions(new, None)
    assert len(diff.files_added) == 1
    assert len(diff.files_removed) == 0
    assert diff.chunks_to_fetch == {'a' * 64}


def test_diff_unchanged_files_are_unchanged():
    f = VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)])
    old = _mk_version([f])
    new = _mk_version([f])
    diff = diff_versions(new, old)
    assert len(diff.files_unchanged) == 1
    assert len(diff.files_added) == 0
    assert len(diff.files_changed) == 0
    assert diff.chunks_to_fetch == set()


def test_diff_added_file_only_fetches_new_chunks():
    old = _mk_version([
        VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)]),
    ])
    new = _mk_version([
        VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)]),
        VersionFile(path='b.toe', size=200, chunks=[VersionChunk(hash='b' * 64, size=200)]),
    ])
    diff = diff_versions(new, old)
    assert len(diff.files_added) == 1
    assert diff.files_added[0].path == 'b.toe'
    assert diff.chunks_to_fetch == {'b' * 64}


def test_diff_removed_file_chunks_eligible_for_gc():
    old = _mk_version([
        VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)]),
        VersionFile(path='b.toe', size=200, chunks=[VersionChunk(hash='b' * 64, size=200)]),
    ])
    new = _mk_version([
        VersionFile(path='a.toe', size=100, chunks=[VersionChunk(hash='a' * 64, size=100)]),
    ])
    diff = diff_versions(new, old)
    assert len(diff.files_removed) == 1
    assert diff.chunks_unused == {'b' * 64}


def test_diff_changed_file_with_shared_chunks():
    # rsync-style: file changed but most chunks same
    old = _mk_version([
        VersionFile(path='a.toe', size=200, chunks=[
            VersionChunk(hash='a' * 64, size=100),
            VersionChunk(hash='b' * 64, size=100),
        ]),
    ])
    new = _mk_version([
        VersionFile(path='a.toe', size=200, chunks=[
            VersionChunk(hash='a' * 64, size=100),  # same
            VersionChunk(hash='c' * 64, size=100),  # new
        ]),
    ])
    diff = diff_versions(new, old)
    assert len(diff.files_changed) == 1
    assert diff.chunks_to_fetch == {'c' * 64}
    assert diff.chunks_unused == {'b' * 64}
