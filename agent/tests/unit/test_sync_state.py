"""tests for sync_state — SQLite WAL state machine for roost."""

import os
import sqlite3
import threading
from pathlib import Path

import pytest

from sync_state import SCHEMA_VERSION, SyncState, SyncStateError


# ─── lifecycle ───────────────────────────────────────────────────────


def test_open_creates_db_and_dir(tmp_path):
    db_path = tmp_path / 'subdir' / 'state.db'
    state = SyncState(str(db_path))
    try:
        assert db_path.exists()
        assert db_path.parent.exists()
    finally:
        state.close()


def test_can_open_close_open_again_round_trip(tmp_path):
    db_path = tmp_path / 'state.db'
    s1 = SyncState(str(db_path))
    s1.close()
    s2 = SyncState(str(db_path))
    s2.close()


def test_context_manager_closes_on_exit(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        # use it
        state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=[],
        )
    # after exit, connection closed — calling op should fail
    with pytest.raises((sqlite3.ProgrammingError, AssertionError, AttributeError)):
        state.list_pending_distributions()


def test_schema_version_stamped_after_create(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        cur = state._conn.execute('PRAGMA user_version')
        assert cur.fetchone()[0] == SCHEMA_VERSION
    finally:
        state.close()


def test_wal_mode_enabled(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        cur = state._conn.execute('PRAGMA journal_mode')
        # journal_mode returns 'wal' (case-insensitive)
        assert cur.fetchone()[0].lower() == 'wal'
    finally:
        state.close()


# ─── distributions ──────────────────────────────────────────────────


def test_start_distribution_creates_row(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='site_a', folder_id='folder_b', manifest_id='m1',
            manifest_url='https://r2/m1.json',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        row = state.get_distribution(dist_id)
        assert row is not None
        assert row['site_id'] == 'site_a'
        assert row['folder_id'] == 'folder_b'
        assert row['manifest_id'] == 'm1'
        assert row['state'] == 'pending'


def test_start_distribution_duplicate_raises(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=[],
        )
        with pytest.raises(SyncStateError, match="already exists"):
            state.start_distribution(
                site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
                files=[], chunks=[],
            )


def test_set_distribution_state_updates(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=[],
        )
        state.set_distribution_state(dist_id, 'downloading')
        row = state.get_distribution(dist_id)
        assert row['state'] == 'downloading'
        state.set_distribution_state(dist_id, 'failed', error='boom')
        row = state.get_distribution(dist_id)
        assert row['state'] == 'failed'
        assert row['error'] == 'boom'


def test_invalid_state_value_rejected(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=[],
        )
        with pytest.raises(sqlite3.IntegrityError):
            state.set_distribution_state(dist_id, 'made_up_state')


def test_find_distribution_by_natural_key(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m1', manifest_url='u',
            files=[], chunks=[],
        )
        row = state.find_distribution('s', 'f', 'm1')
        assert row is not None
        assert state.find_distribution('s', 'f', 'never') is None


def test_list_pending_distributions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        d1 = state.start_distribution(site_id='s', folder_id='f1', manifest_id='m', manifest_url='u', files=[], chunks=[])
        d2 = state.start_distribution(site_id='s', folder_id='f2', manifest_id='m', manifest_url='u', files=[], chunks=[])
        state.set_distribution_state(d2, 'committed')
        pending = state.list_pending_distributions()
        ids = [p['id'] for p in pending]
        assert d1 in ids
        assert d2 not in ids


# ─── chunks ──────────────────────────────────────────────────────────


def test_chunk_state_transitions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[],
            chunks=[{'hash': 'a' * 64, 'size': 100}, {'hash': 'b' * 64, 'size': 200}],
        )
        chunks = state.list_chunks(dist_id)
        assert len(chunks) == 2
        assert all(c['state'] == 'planned' for c in chunks)

        state.set_chunk_state(dist_id, 'a' * 64, 'verified')
        verified = state.list_chunks(dist_id, state='verified')
        assert len(verified) == 1
        assert verified[0]['hash'] == 'a' * 64


def test_chunk_attempts_counter_increments(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        for _ in range(3):
            state.set_chunk_state(dist_id, 'a' * 64, 'failed', error='retry', increment_attempts=True)
        row = state.list_chunks(dist_id)[0]
        assert row['attempts'] == 3


# ─── files ──────────────────────────────────────────────────────────


def test_file_state_transitions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': 'a.toe', 'size': 100}, {'path': 'b.toe', 'size': 200}],
            chunks=[],
        )
        files = state.list_files(dist_id)
        assert len(files) == 2
        state.set_file_state(dist_id, 'a.toe', 'committed')
        committed = state.list_files(dist_id, state='committed')
        assert len(committed) == 1


# ─── progress aggregation ───────────────────────────────────────────


def test_progress_summary_counts_by_state(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[
                {'hash': 'a' * 64, 'size': 100},
                {'hash': 'b' * 64, 'size': 200},
            ],
        )
        state.set_chunk_state(dist_id, 'a' * 64, 'verified')
        summary = state.progress_summary(dist_id)
        assert summary['chunks']['planned']['n'] == 1
        assert summary['chunks']['verified']['n'] == 1
        assert summary['chunks']['verified']['bytes'] == 100
        assert summary['files']['planned'] == 1


# ─── concurrency ────────────────────────────────────────────────────


def test_concurrent_writes_are_serialized(tmp_path):
    """multiple threads can set chunk state without losing updates."""
    with SyncState(str(tmp_path / 'state.db')) as state:
        # set up 50 chunks
        chunks = [{'hash': f'{i:064x}', 'size': 100} for i in range(50)]
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[], chunks=chunks,
        )

        def mark_verified(idx):
            state.set_chunk_state(dist_id, f'{idx:064x}', 'verified')

        threads = [threading.Thread(target=mark_verified, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        verified = state.list_chunks(dist_id, state='verified')
        assert len(verified) == 50


# ─── crash safety (smoke test) ──────────────────────────────────────


def test_crash_safe_state_survives_close_reopen(tmp_path):
    """data persists across process boundary (open/close/open)."""
    db_path = tmp_path / 'state.db'
    with SyncState(str(db_path)) as state:
        dist_id = state.start_distribution(
            site_id='s', folder_id='f', manifest_id='m', manifest_url='u',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        state.set_chunk_state(dist_id, 'a' * 64, 'verified')

    # reopen
    with SyncState(str(db_path)) as state:
        row = state.find_distribution('s', 'f', 'm')
        assert row is not None
        chunks = state.list_chunks(row['id'], state='verified')
        assert len(chunks) == 1
