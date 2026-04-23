"""tests for sync_manifest — fetch + cache + diff + validate."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sync_manifest import (
    MANIFEST_MEDIA_TYPE,
    MANIFEST_SCHEMA_VERSION,
    Manifest,
    ManifestChunk,
    ManifestError,
    ManifestFile,
    diff_manifests,
    fetch_manifest,
)


def _valid_manifest_json(files=None):
    """build a minimal valid manifest dict for tests."""
    return {
        'schemaVersion': MANIFEST_SCHEMA_VERSION,
        'mediaType': MANIFEST_MEDIA_TYPE,
        'config': {
            'name': 'test-folder',
            'createdAt': '2026-04-19T00:00:00Z',
            'createdBy': 'test',
            'siteId': 'site_test',
            'folderId': 'folder_test',
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


def test_valid_manifest_parses(tmp_path):
    raw = json.dumps(_valid_manifest_json()).encode('utf-8')
    cache_path = tmp_path / 'manifests'
    with patch('sync_manifest._http_fetch', return_value=raw):
        m = fetch_manifest('http://example/m.json', expected_manifest_id='m1', cache_dir=str(cache_path))
    assert m.schema_version == 2
    assert len(m.files) == 1
    assert m.files[0].path == 'a.toe'
    assert m.total_size == 100


def test_unsupported_schema_version_rejected():
    body = _valid_manifest_json()
    body['schemaVersion'] = 999
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="schemaVersion"):
            fetch_manifest('http://example/m.json')


def test_wrong_media_type_rejected():
    body = _valid_manifest_json()
    body['mediaType'] = 'application/json'
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="mediaType"):
            fetch_manifest('http://example/m.json')


def test_path_with_dotdot_rejected():
    body = _valid_manifest_json(files=[
        {'path': '../etc/evil', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_absolute_path_rejected():
    body = _valid_manifest_json(files=[
        {'path': '/etc/passwd', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_backslash_traversal_rejected():
    """windows-style traversal with backslash separators — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': '..\\etc\\evil', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_mixed_traversal_rejected():
    """path like `foo/../../bar` — survives segment split — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': 'foo/../../bar', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_windows_drive_absolute_rejected():
    """`C:/foo` or `C:\\foo` — rejected — wave 4b.2."""
    for path_val in ('C:/foo.toe', 'C:\\foo.toe', 'D:relative.toe'):
        body = _valid_manifest_json(files=[
            {'path': path_val, 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
        ])
        raw = json.dumps(body).encode('utf-8')
        with patch('sync_manifest._http_fetch', return_value=raw):
            with pytest.raises(ManifestError, match="path constraints"):
                fetch_manifest('http://example/m.json')


def test_null_byte_rejected():
    """NUL byte anywhere in path — rejected — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': 'inno\x00cent.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_dot_segment_rejected():
    """path with `.` segment — rejected (non-canonical) — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': 'a/./b.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_empty_segment_rejected():
    """path with `//` — rejected (non-canonical) — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': 'a//b.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_ads_colon_in_segment_rejected():
    """windows alternate data stream syntax (`file.toe:hidden`) — rejected — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': 'a/file.toe:hidden', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_unc_path_rejected():
    """UNC-style path `\\\\server\\share\\foo` — starts with separator — rejected — wave 4b.2."""
    body = _valid_manifest_json(files=[
        {'path': '\\\\server\\share\\foo.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="path constraints"):
            fetch_manifest('http://example/m.json')


def test_unicode_double_dot_lookalike_allowed():
    """
    cve-2025-4330 regression — unicode lookalike (U+2025 TWO DOT LEADER) is
    NOT `..`. the parser rejects literal `..` not visually similar glyphs;
    the real defense against exotic unicode escaping is realpath enforcement
    in destination_allowlist (at write time). confirm the parser doesn't
    false-positive and drop legit unicode filenames.
    """
    body = _valid_manifest_json(files=[
        {'path': 'docs/\u2025note.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        manifest = fetch_manifest('http://example/m.json')
        assert manifest.files[0].path == 'docs/\u2025note.toe'


def test_uppercase_hash_rejected():
    body = _valid_manifest_json(files=[
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'A' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="lowercase"):
            fetch_manifest('http://example/m.json')


def test_chunk_size_sum_must_equal_file_size():
    body = _valid_manifest_json(files=[
        {'path': 'a.toe', 'size': 200,  # claims 200 but chunk only 100
         'chunks': [{'hash': 'a' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="sum"):
            fetch_manifest('http://example/m.json')


def test_duplicate_path_rejected():
    body = _valid_manifest_json(files=[
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'a' * 64, 'size': 100}]},
        {'path': 'a.toe', 'size': 100, 'chunks': [{'hash': 'b' * 64, 'size': 100}]},
    ])
    raw = json.dumps(body).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw):
        with pytest.raises(ManifestError, match="duplicated"):
            fetch_manifest('http://example/m.json')


def test_invalid_json_rejected():
    with patch('sync_manifest._http_fetch', return_value=b'{not valid json'):
        with pytest.raises(ManifestError, match="json"):
            fetch_manifest('http://example/m.json')


# ─── cache ───────────────────────────────────────────────────────────


def test_cache_hit_skips_http(tmp_path):
    cache_dir = tmp_path / 'manifests'
    cache_dir.mkdir(parents=True)
    raw = json.dumps(_valid_manifest_json()).encode('utf-8')
    (cache_dir / 'm1.json').write_bytes(raw)

    fake_fetch = MagicMock()
    with patch('sync_manifest._http_fetch', fake_fetch):
        m = fetch_manifest('http://example/m.json', expected_manifest_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 0
    assert len(m.files) == 1


def test_cache_miss_fetches_and_writes_cache(tmp_path):
    cache_dir = tmp_path / 'manifests'
    raw = json.dumps(_valid_manifest_json()).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw) as fake_fetch:
        m = fetch_manifest('http://example/m.json', expected_manifest_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 1
    cached = cache_dir / 'm1.json'
    assert cached.exists()
    assert cached.read_bytes() == raw


def test_corrupt_cache_falls_through_to_fetch(tmp_path):
    cache_dir = tmp_path / 'manifests'
    cache_dir.mkdir(parents=True)
    (cache_dir / 'm1.json').write_bytes(b'corrupt garbage')
    raw = json.dumps(_valid_manifest_json()).encode('utf-8')
    with patch('sync_manifest._http_fetch', return_value=raw) as fake_fetch:
        m = fetch_manifest('http://example/m.json', expected_manifest_id='m1', cache_dir=str(cache_dir))
    assert fake_fetch.call_count == 1
    assert len(m.files) == 1


# ─── diff ────────────────────────────────────────────────────────────


def _mk_manifest(files):
    """build a Manifest in-memory (without parsing JSON)."""
    return Manifest(
        schema_version=2,
        media_type=MANIFEST_MEDIA_TYPE,
        config={},
        files=files,
        raw_bytes=b'',
    )


def test_diff_first_install_marks_everything_added():
    new = _mk_manifest([
        ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)]),
    ])
    diff = diff_manifests(new, None)
    assert len(diff.files_added) == 1
    assert len(diff.files_removed) == 0
    assert diff.chunks_to_fetch == {'a' * 64}


def test_diff_unchanged_files_are_unchanged():
    f = ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)])
    old = _mk_manifest([f])
    new = _mk_manifest([f])
    diff = diff_manifests(new, old)
    assert len(diff.files_unchanged) == 1
    assert len(diff.files_added) == 0
    assert len(diff.files_changed) == 0
    assert diff.chunks_to_fetch == set()


def test_diff_added_file_only_fetches_new_chunks():
    old = _mk_manifest([
        ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)]),
    ])
    new = _mk_manifest([
        ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)]),
        ManifestFile(path='b.toe', size=200, chunks=[ManifestChunk(hash='b' * 64, size=200)]),
    ])
    diff = diff_manifests(new, old)
    assert len(diff.files_added) == 1
    assert diff.files_added[0].path == 'b.toe'
    assert diff.chunks_to_fetch == {'b' * 64}


def test_diff_removed_file_chunks_eligible_for_gc():
    old = _mk_manifest([
        ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)]),
        ManifestFile(path='b.toe', size=200, chunks=[ManifestChunk(hash='b' * 64, size=200)]),
    ])
    new = _mk_manifest([
        ManifestFile(path='a.toe', size=100, chunks=[ManifestChunk(hash='a' * 64, size=100)]),
    ])
    diff = diff_manifests(new, old)
    assert len(diff.files_removed) == 1
    assert diff.chunks_unused == {'b' * 64}


def test_diff_changed_file_with_shared_chunks():
    # rsync-style: file changed but most chunks same
    old = _mk_manifest([
        ManifestFile(path='a.toe', size=200, chunks=[
            ManifestChunk(hash='a' * 64, size=100),
            ManifestChunk(hash='b' * 64, size=100),
        ]),
    ])
    new = _mk_manifest([
        ManifestFile(path='a.toe', size=200, chunks=[
            ManifestChunk(hash='a' * 64, size=100),  # same
            ManifestChunk(hash='c' * 64, size=100),  # new
        ]),
    ])
    diff = diff_manifests(new, old)
    assert len(diff.files_changed) == 1
    assert diff.chunks_to_fetch == {'c' * 64}
    assert diff.chunks_unused == {'b' * 64}
