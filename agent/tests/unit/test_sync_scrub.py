"""tests for sync_scrub — periodic on-disk integrity verification (wave 4b.7)."""

import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sync_version import Version, VersionChunk, VersionFile, VERSION_MEDIA_TYPE
from sync_scrub import (
    DEFAULT_SCRUB_REPORT_DIR,
    FileDrift,
    ScrubReport,
    scrub_distribution,
)
from sync_state import SyncState


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _mk_version_file(path: str, chunk_data_list):
    chunks = []
    total = 0
    for d in chunk_data_list:
        chunks.append(VersionChunk(hash=_hash(d), size=len(d)))
        total += len(d)
    return VersionFile(path=path, size=total, chunks=chunks)


def _setup_committed_distribution(tmp_path, files_data):
    """
    set up: a committed distribution + on-disk files matching the version +
    a SyncState with the right rows.

    files_data: dict[path -> [chunk_bytes, ...]]
    returns: (state, dist_id, extract_root, version)
    """
    state = SyncState(str(tmp_path / 'state.db'))
    extract = tmp_path / 'extract'
    extract.mkdir()

    files = []
    for path, chunk_data_list in files_data.items():
        f = _mk_version_file(path, chunk_data_list)
        files.append(f)
        # write the assembled file on disk (concatenation of chunks)
        target = extract / Path(*path.split('/'))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b''.join(chunk_data_list))

    version = Version(
        schema_version=2,
        media_type=VERSION_MEDIA_TYPE,
        config={'name': 'test'},
        files=files,
        raw_bytes=b'',
    )

    dist_id = state.start_distribution(
        site_id='s', roost_id='f', version_id='m', version_url='https://r2/m.json',
        files=[{'path': f.path, 'size': f.size} for f in files],
        chunks=[
            {'hash': c.hash, 'size': c.size}
            for f in files for c in f.chunks
        ],
    )
    state.set_distribution_state(dist_id, 'committed')
    return state, dist_id, str(extract), version


# ─── happy path ──────────────────────────────────────────────────────


def test_healthy_distribution_returns_no_drift(tmp_path):
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'hello world']}
    )
    try:
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert report.healthy
        assert report.files_checked == 1
        assert len(report.drifts) == 0
    finally:
        state.close()


def test_multi_chunk_file_healthy(tmp_path):
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'chunk one', b'chunk two', b'chunk three']}
    )
    try:
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert report.healthy
    finally:
        state.close()


# ─── drift detection ────────────────────────────────────────────────


def test_missing_file_reported_as_drift(tmp_path):
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'data']}
    )
    try:
        # delete the assembled file
        (Path(extract) / 'a.toe').unlink()
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert not report.healthy
        assert len(report.drifts) == 1
        assert report.drifts[0].reason == 'missing'
        assert report.drifts[0].actual_size is None
    finally:
        state.close()


def test_size_mismatch_reported(tmp_path):
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'expected data']}
    )
    try:
        # overwrite with wrong size
        (Path(extract) / 'a.toe').write_bytes(b'short')
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert not report.healthy
        assert report.drifts[0].reason == 'size_mismatch'
        assert report.drifts[0].actual_size == 5
    finally:
        state.close()


def test_silent_bit_rot_caught_by_hash(tmp_path):
    """same size but different content — what mtime-based scrubs miss."""
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'original data']}
    )
    try:
        # overwrite with different content but SAME size
        (Path(extract) / 'a.toe').write_bytes(b'corrupted!!!!')  # same length
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert not report.healthy
        assert report.drifts[0].reason == 'hash_mismatch'
    finally:
        state.close()


def test_healthy_files_not_in_drift_list(tmp_path):
    """a mix of healthy + corrupt files: only the bad ones appear in drifts."""
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path,
        {
            'good.toe': [b'unchanged'],
            'bad.toe': [b'will-be-corrupted'],
        },
    )
    try:
        # corrupt only one
        (Path(extract) / 'bad.toe').write_bytes(b'corrupted-content')
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert not report.healthy
        assert report.files_checked == 2
        assert len(report.drifts) == 1
        assert report.drifts[0].path == 'bad.toe'
    finally:
        state.close()


# ─── skip + edge cases ──────────────────────────────────────────────


def test_files_in_failed_state_are_skipped(tmp_path):
    """already-known-failed files don't get re-checked (no point)."""
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path,
        {
            'good.toe': [b'unchanged'],
            'failed.toe': [b'already-failed'],
        },
    )
    try:
        # mark one file as failed in state
        state.set_file_state(dist_id, 'failed.toe', 'failed', error='earlier failure')
        # delete it on disk too — would be a drift if checked
        (Path(extract) / 'failed.toe').unlink()
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(
                dist_id, extract, state,
                report_dir=str(tmp_path / 'reports'),
            )
        assert report.files_checked == 1
        assert report.files_skipped == 1
        # only good.toe was checked; no drifts for failed.toe
        assert all(d.path != 'failed.toe' for d in report.drifts)
    finally:
        state.close()


def test_non_committed_distribution_raises(tmp_path):
    """only 'committed' distributions are scrub-eligible (in-flight ones race)."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[],
        )
        # state defaults to 'pending'
        with pytest.raises(ValueError, match="committed"):
            scrub_distribution(dist_id, str(tmp_path), state)
    finally:
        state.close()


def test_unknown_distribution_raises(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        with pytest.raises(ValueError, match="not found"):
            scrub_distribution(99999, str(tmp_path), state)
    finally:
        state.close()


# ─── report persistence ─────────────────────────────────────────────


def test_report_written_as_json(tmp_path):
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'data']}
    )
    report_dir = tmp_path / 'reports'
    try:
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(dist_id, extract, state, report_dir=str(report_dir))
        # one json file exists in report_dir
        files = list(report_dir.glob('scrub_*.json'))
        assert len(files) == 1
        loaded = json.loads(files[0].read_text())
        assert loaded['distribution_id'] == dist_id
        assert loaded['site_id'] == 's'
        assert loaded['roost_id'] == 'f'
    finally:
        state.close()


def test_report_persistence_failure_does_not_raise(tmp_path):
    """if report_dir is unwritable, scrub completes anyway with in-memory report."""
    state, dist_id, extract, version = _setup_committed_distribution(
        tmp_path, {'a.toe': [b'data']}
    )
    try:
        # use a path that can't be created (a file masquerading as a dir)
        bogus_dir = tmp_path / 'not_a_dir'
        bogus_dir.write_text('this is a file')
        with patch('sync_scrub.fetch_version', return_value=version):
            report = scrub_distribution(dist_id, extract, state, report_dir=str(bogus_dir))
        # in-memory report is still healthy
        assert report.healthy
    finally:
        state.close()
