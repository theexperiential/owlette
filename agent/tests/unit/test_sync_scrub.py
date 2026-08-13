"""tests for sync_scrub — periodic on-disk integrity verification (wave 4b.7)."""

import hashlib
import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from sync_version import Version, VersionChunk, VersionFile, VERSION_MEDIA_TYPE
from sync_scrub import (
    DEFAULT_ORPHAN_MIN_AGE_SECONDS,
    DEFAULT_SCRUB_REPORT_DIR,
    FileDrift,
    ReapReport,
    ScrubReport,
    reap_orphan_chunks,
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


# ─── content-store reaper ────────────────────────────────────────────


def _put_store_chunk(store: Path, data: bytes, age_seconds: float = 0.0,
                     suffix: str = '') -> str:
    """
    write a content-addressed chunk into the sharded store and back-date it
    by `age_seconds`. returns the hash.
    """
    h = _hash(data)
    target = store / h[:2] / (h + suffix)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    if age_seconds:
        old = time.time() - age_seconds
        os.utime(target, (old, old))
    return h


def _state_with_distribution(tmp_path, state_name, dist_state, chunk_hashes):
    """a SyncState holding one distribution in `dist_state` owning `chunk_hashes`."""
    state = SyncState(str(tmp_path / state_name))
    dist_id = state.start_distribution(
        site_id='s', roost_id='r', version_id='v', version_url='u',
        files=[],
        chunks=[{'hash': h, 'size': 4} for h in chunk_hashes],
        extract_root=str(tmp_path / 'extract'),
    )
    if dist_state != 'pending':
        state.set_distribution_state(dist_id, dist_state)
    return state


def test_reaper_deletes_unreferenced_aged_chunks(tmp_path):
    """the leak this closes: a chunk no distribution references, sitting for days."""
    store = tmp_path / 'content'
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        h = _put_store_chunk(store, b'orphan bytes', age_seconds=48 * 3600)
        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.deleted == 1
        assert report.bytes_freed == len(b'orphan bytes')
        assert report.deleted_hashes == [h]
        assert not (store / h[:2] / h).exists()
    finally:
        state.close()


def test_reaper_keeps_chunks_younger_than_the_age_threshold(tmp_path):
    """
    an in-flight distribution that has written blobs but not yet registered
    its rows must not lose them — the age threshold is the guard.
    """
    store = tmp_path / 'content'
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        fresh = _put_store_chunk(store, b'just downloaded', age_seconds=60)
        stale = _put_store_chunk(store, b'ancient orphan', age_seconds=48 * 3600)

        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.kept_recent == 1
        assert report.deleted == 1
        assert report.deleted_hashes == [stale]
        assert (store / fresh[:2] / fresh).exists()
        assert not (store / stale[:2] / stale).exists()
    finally:
        state.close()


def test_reaper_keeps_chunks_referenced_by_an_active_distribution(tmp_path):
    """age alone is not enough — a downloading distribution keeps its bytes."""
    store = tmp_path / 'content'
    h = _put_store_chunk(store, b'needed by a live sync', age_seconds=48 * 3600)
    state = _state_with_distribution(tmp_path, 'state.db', 'downloading', [h])
    try:
        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.deleted == 0
        assert report.kept_referenced == 1
        assert (store / h[:2] / h).exists()
    finally:
        state.close()


@pytest.mark.parametrize('terminal_state', ['committed', 'failed', 'cancelled'])
def test_reaper_collects_chunks_of_terminal_distributions(tmp_path, terminal_state):
    """
    a distribution that ended is never resumed, so its leftovers are exactly
    what the reaper is for (this is the failed-distribution leak).
    """
    store = tmp_path / 'content'
    h = _put_store_chunk(store, b'leftover from a dead sync', age_seconds=48 * 3600)
    state = _state_with_distribution(tmp_path, f'state-{terminal_state}.db',
                                     terminal_state, [h])
    try:
        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.deleted == 1
        assert not (store / h[:2] / h).exists()
    finally:
        state.close()


def test_reaper_collects_abandoned_partial_downloads(tmp_path):
    """`<hash>.partial` sidecars leak the same way finished blobs do."""
    store = tmp_path / 'content'
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        h = _put_store_chunk(store, b'half a chunk', age_seconds=48 * 3600,
                             suffix='.partial')
        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.deleted == 1
        assert not (store / h[:2] / (h + '.partial')).exists()
    finally:
        state.close()


def test_reaper_ignores_files_that_are_not_chunks(tmp_path):
    """the reaper only deletes files it can prove it wrote."""
    store = tmp_path / 'content'
    shard = store / 'ab'
    shard.mkdir(parents=True)
    stranger = shard / 'not-a-chunk.txt'
    stranger.write_bytes(b'someone else put this here')
    old = time.time() - 48 * 3600
    os.utime(stranger, (old, old))

    state = SyncState(str(tmp_path / 'state.db'))
    try:
        report = reap_orphan_chunks(state, content_store=str(store))

        assert report.deleted == 0
        assert report.kept_unrecognized == 1
        assert stranger.exists()
    finally:
        state.close()


def test_reaper_dry_run_reports_without_deleting(tmp_path):
    """dry-run is how an operator sizes the reap before letting it run."""
    store = tmp_path / 'content'
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        h = _put_store_chunk(store, b'orphan bytes', age_seconds=48 * 3600)
        report = reap_orphan_chunks(state, content_store=str(store), dry_run=True)

        assert report.dry_run is True
        assert report.deleted == 1
        assert report.deleted_hashes == [h]
        assert (store / h[:2] / h).exists()
    finally:
        state.close()


def test_reaper_age_threshold_is_configurable(tmp_path):
    """
    the 24h default is a policy, not a law — a caller can tighten it. a chunk
    older than the caller's threshold but far younger than the default is
    collected only because the threshold moved.
    """
    store = tmp_path / 'content'
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        h = _put_store_chunk(store, b'ten-minute-old orphan', age_seconds=600)
        assert 600 < DEFAULT_ORPHAN_MIN_AGE_SECONDS  # the default would keep it

        kept = reap_orphan_chunks(state, content_store=str(store))
        assert kept.deleted == 0
        assert kept.kept_recent == 1

        report = reap_orphan_chunks(state, content_store=str(store), min_age_seconds=60)
        assert report.deleted == 1
        assert not (store / h[:2] / h).exists()
    finally:
        state.close()


def test_reaper_on_missing_content_store_is_a_noop(tmp_path):
    """a machine that has never synced has no store — that is not an error."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        report = reap_orphan_chunks(state, content_store=str(tmp_path / 'nope'))
        assert report.scanned == 0
        assert report.deleted == 0
    finally:
        state.close()


# ─── scrub-report retention ──────────────────────────────────────────


def _write_reports(report_dir: Path, count: int, first_age_seconds: float = 0.0):
    """`count` fake scrub reports, oldest first, back-dated by 1h steps."""
    report_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for i in range(count):
        p = report_dir / f'scrub_1_{1000 + i}.json'
        p.write_text('{}', encoding='utf-8')
        age = first_age_seconds + (count - i) * 3600
        stamp = time.time() - age
        os.utime(p, (stamp, stamp))
        written.append(p)
    return written


def test_scrub_reports_are_capped_at_the_newest_n(tmp_path):
    """
    hourly scrubs would otherwise leave a JSON file per run forever — nothing
    else cleans this directory.
    """
    from sync_scrub import MAX_SCRUB_REPORTS, _prune_old_reports

    rd = tmp_path / 'reports'
    written = _write_reports(rd, MAX_SCRUB_REPORTS + 10)

    deleted = _prune_old_reports(rd)

    remaining = sorted(rd.glob('scrub_*.json'))
    assert deleted == 10
    assert len(remaining) == MAX_SCRUB_REPORTS
    # the survivors are the newest ones (highest index == most recent mtime)
    assert written[-1] in remaining
    assert written[0] not in remaining


def test_scrub_reports_older_than_the_age_limit_are_dropped(tmp_path):
    """even under the count cap, an ancient report is not worth keeping."""
    from sync_scrub import _prune_old_reports

    rd = tmp_path / 'reports'
    rd.mkdir()
    fresh = rd / 'scrub_1_2000.json'
    ancient = rd / 'scrub_1_1000.json'
    for p in (fresh, ancient):
        p.write_text('{}', encoding='utf-8')
    old = time.time() - (45 * 24 * 3600)
    os.utime(ancient, (old, old))

    deleted = _prune_old_reports(rd)

    assert deleted == 1
    assert fresh.exists()
    assert not ancient.exists()


def test_scrub_report_pruning_ignores_foreign_files(tmp_path):
    """only our own `scrub_*.json` naming is eligible."""
    from sync_scrub import _prune_old_reports

    rd = tmp_path / 'reports'
    rd.mkdir()
    stranger = rd / 'operator-notes.txt'
    stranger.write_text('keep me', encoding='utf-8')
    old = time.time() - (400 * 24 * 3600)
    os.utime(stranger, (old, old))

    assert _prune_old_reports(rd) == 0
    assert stranger.exists()


def test_writing_a_report_trims_the_directory(tmp_path):
    """the trim is wired into the write path, not just available as a helper."""
    from sync_scrub import MAX_SCRUB_REPORTS, ScrubReport, _write_report

    rd = tmp_path / 'reports'
    _write_reports(rd, MAX_SCRUB_REPORTS + 5)

    report = ScrubReport(
        distribution_id=7, site_id='s', roost_id='r', version_id='v',
        extract_root=str(tmp_path), started_at=time.time(), finished_at=time.time(),
        files_checked=1, files_skipped=0,
    )
    _write_report(report, str(rd))

    assert len(list(rd.glob('scrub_*.json'))) == MAX_SCRUB_REPORTS
    assert (rd / f'scrub_7_{int(report.finished_at)}.json').exists()
