"""
sync_state — crash-safe local state for roost (project distribution v2).

tracks per-roost sync progress in a SQLite database with WAL journaling
so that an agent crash, power loss, or service restart NEVER loses state.
the version cache + chunk-download progress + reassembly intent live
here; on startup, the agent walks pending sync ops and resumes them.

design principles:
- single state DB per agent install at %PROGRAMDATA%\Owlette\sync-state.db on
  windows, or $XDG_DATA_HOME/owlette/sync-state.db (≡ ~/.local/share/owlette/)
  on POSIX. kept OUT of the user's Documents tree so the cache can't leak into
  the same directory as user-visible assembled files.
- WAL mode for atomic writes + concurrent readers (the cortex MCP can read
  sync state without blocking the worker thread)
- every long-running op writes a row BEFORE starting and updates rows
  rather than deleting+inserting (audit trail for postmortems)
- foreign keys enabled; cascade deletes when a roost is removed
- schema migration via PRAGMA user_version + numbered migration steps

NOT this module's job:
- chunk download (sync_downloader.py)
- file reassembly (sync_assembler.py)
- version fetch + diff (sync_version.py)
- HTTP, network, or filesystem I/O (only SQLite)

reference: roost plan, wave 4a.4. consumed by sync_version, sync_downloader,
sync_assembler, sync_commands.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, List, Optional

logger = logging.getLogger(__name__)

# sqlite schema version stamped into PRAGMA user_version. lets a future
# in-place upgrade detect "this DB was created by a previous shape".
# bump only when the schema CHANGES after roost ships in production —
# until then there's no installed DB in the wild to migrate from, so
# the create_schema function below is the source of truth.
SCHEMA_VERSION = 1

def _default_state_db_path() -> str:
    """
    resolve the default state DB path.

    windows: %PROGRAMDATA%\\Owlette\\sync-state.db  (typically C:\\ProgramData\\Owlette\\...)
    POSIX:   $XDG_DATA_HOME/owlette/sync-state.db, else ~/.local/share/owlette/sync-state.db

    rationale: the agent runs as LocalSystem on windows. `~` expands to
    `C:\\Windows\\System32\\config\\systemprofile` under that account, which
    is not an appropriate place for a rebuildable cache — operators can't
    see or clean it up without elevation. ProgramData is the canonical
    machine-wide application-data location and LocalSystem has write access
    without tricks. on POSIX (test environments only) we follow XDG.
    """
    if os.name == 'nt':
        program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')
        return os.path.join(program_data, 'Owlette', 'sync-state.db')
    xdg = os.environ.get('XDG_DATA_HOME')
    if xdg:
        return os.path.join(xdg, 'owlette', 'sync-state.db')
    return os.path.join(os.path.expanduser('~'), '.local', 'share', 'owlette', 'sync-state.db')


# default state DB location. computed lazily so a test-time env override
# (XDG_DATA_HOME) takes effect; call sites that need the string should use
# _default_state_db_path() rather than DEFAULT_STATE_DB_PATH directly.
DEFAULT_STATE_DB_PATH = _default_state_db_path()

# transition states for chunk + file rows.
# CHUNK: planned -> downloading -> verified -> assembled
# FILE:  planned -> assembling -> assembled -> committed
# distribution rows progress through:
#         pending -> downloading -> verifying -> assembling -> committed
#         (or -> failed | cancelled at any stage)


class SyncStateError(Exception):
    """raised when state-store operations fail in a way callers must handle."""
    pass


class SyncState:
    """
    crash-safe SQLite-backed state for roost sync operations.

    construction:
        state = SyncState()                    # default path
        state = SyncState('/tmp/test.db')      # explicit path (tests)

    use as a context manager OR call .close() explicitly:
        with SyncState() as state:
            state.start_distribution(...)
    """

    def __init__(self, db_path: Optional[str] = None) -> None:
        if db_path is None:
            # recompute at construction so a test fixture mutating env vars
            # (e.g. XDG_DATA_HOME) AFTER module import still takes effect.
            db_path = _default_state_db_path()
        else:
            db_path = os.path.expanduser(db_path)
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._open()

    # ─── lifecycle ────────────────────────────────────────────────────

    def _open(self) -> None:
        # ensure parent dir exists; SQLite will create the file itself.
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False because we serialize via self._lock and
        # share a single connection across the agent's worker threads.
        # WAL mode + a single connection avoids the SQLite-per-thread
        # gotcha while still giving safe concurrent access.
        self._conn = sqlite3.connect(
            str(self._db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; explicit BEGIN/COMMIT in transactions
        )
        # WAL: writers don't block readers; survives crash + power loss.
        # synchronous=NORMAL: durable across power loss (fsync on commit) but
        # ~3x faster than FULL — appropriate for an event log we can replay
        # against the version if a few entries are missing.
        # foreign_keys=ON: cascade deletes work + integrity enforcement.
        self._conn.execute('PRAGMA journal_mode = WAL')
        self._conn.execute('PRAGMA synchronous = NORMAL')
        self._conn.execute('PRAGMA foreign_keys = ON')
        self._conn.row_factory = sqlite3.Row
        self._run_migrations()
        logger.info(f"sync_state opened at {self._db_path}")

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def __enter__(self) -> 'SyncState':
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # ─── schema ───────────────────────────────────────────────────────

    def _run_migrations(self) -> None:
        """
        create the schema if the DB is fresh; otherwise no-op.

        we don't have an installed DB in the wild yet — roost hasn't shipped.
        once it has, future schema CHANGES (not the initial create) will
        re-introduce stepped migrations here.
        """
        assert self._conn is not None
        cur = self._conn.execute('PRAGMA user_version')
        current = cur.fetchone()[0]
        if current >= SCHEMA_VERSION:
            return
        with self._txn():
            self._create_schema()
            self._conn.execute(f'PRAGMA user_version = {SCHEMA_VERSION}')
        logger.info(f"sync_state schema created (v{SCHEMA_VERSION})")

    def _create_schema(self) -> None:
        """create the full schema from scratch. single source of truth."""
        assert self._conn is not None
        # distribution = one in-flight or completed sync op for a roost.
        # site_id + roost_id is the natural key; a new version creates a
        # new distribution row (immutable history).
        # extract_root + last_scrub_at support the periodic scrub.
        self._conn.execute('''
            CREATE TABLE distributions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id         TEXT NOT NULL,
                roost_id        TEXT NOT NULL,
                version_id      TEXT NOT NULL,
                version_url     TEXT NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'pending', 'downloading', 'verifying',
                    'assembling', 'committed', 'failed', 'cancelled'
                )),
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                error           TEXT,
                extract_root    TEXT,
                last_scrub_at   INTEGER,
                UNIQUE (site_id, roost_id, version_id)
            )
        ''')
        # file = a target file the agent will reassemble from chunks.
        self._conn.execute('''
            CREATE TABLE files (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                distribution_id INTEGER NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
                path            TEXT NOT NULL,
                size            INTEGER NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'planned', 'assembling', 'assembled', 'committed', 'failed'
                )),
                error           TEXT,
                UNIQUE (distribution_id, path)
            )
        ''')
        # chunk = one content-addressed blob this distribution needs.
        # the same hash may appear in multiple distributions (dedup) but
        # the chunks table tracks per-distribution download intent.
        self._conn.execute('''
            CREATE TABLE chunks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                distribution_id INTEGER NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
                hash            TEXT NOT NULL,
                size            INTEGER NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'planned', 'downloading', 'verified', 'failed'
                )),
                attempts        INTEGER NOT NULL DEFAULT 0,
                error           TEXT,
                UNIQUE (distribution_id, hash)
            )
        ''')
        # indexes for the common queries.
        self._conn.execute('CREATE INDEX idx_distributions_state ON distributions(state)')
        self._conn.execute('CREATE INDEX idx_distributions_scrub ON distributions(state, last_scrub_at)')
        self._conn.execute('CREATE INDEX idx_chunks_state ON chunks(distribution_id, state)')
        self._conn.execute('CREATE INDEX idx_chunks_hash ON chunks(hash)')
        self._conn.execute('CREATE INDEX idx_files_distribution ON files(distribution_id)')

    # ─── transactions ─────────────────────────────────────────────────

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Connection]:
        """
        BEGIN ... COMMIT/ROLLBACK wrapper. all multi-statement writes go
        through this so they're atomic across crash/power-loss.
        """
        assert self._conn is not None
        with self._lock:
            self._conn.execute('BEGIN IMMEDIATE')
            try:
                yield self._conn
                self._conn.execute('COMMIT')
            except Exception:
                self._conn.execute('ROLLBACK')
                raise

    # ─── distributions ────────────────────────────────────────────────

    def start_distribution(
        self,
        site_id: str,
        roost_id: str,
        version_id: str,
        version_url: str,
        files: List[dict],
        chunks: List[dict],
        extract_root: Optional[str] = None,
    ) -> int:
        """
        register a new distribution and its planned files + chunks. atomic.

        files: list of {path, size}
        chunks: list of {hash, size}
        extract_root: where assembled files land on disk. required for the
            periodic scrub to find them later; optional for backward compat
            with v1 callers (those distributions are silently skipped by scrub).

        returns the distribution row id. raises SyncStateError if a row
        already exists for (site_id, roost_id, version_id).
        """
        now = _now()
        try:
            with self._txn() as conn:
                cur = conn.execute(
                    '''INSERT INTO distributions
                       (site_id, roost_id, version_id, version_url,
                        state, created_at, updated_at, extract_root)
                       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)''',
                    (site_id, roost_id, version_id, version_url, now, now, extract_root),
                )
                dist_id = cur.lastrowid
                if files:
                    conn.executemany(
                        '''INSERT INTO files (distribution_id, path, size, state)
                           VALUES (?, ?, ?, 'planned')''',
                        [(dist_id, f['path'], f['size']) for f in files],
                    )
                if chunks:
                    conn.executemany(
                        '''INSERT INTO chunks (distribution_id, hash, size, state)
                           VALUES (?, ?, ?, 'planned')''',
                        [(dist_id, c['hash'], c['size']) for c in chunks],
                    )
                return dist_id
        except sqlite3.IntegrityError as e:
            raise SyncStateError(
                f"distribution already exists for "
                f"site={site_id!r} roost={roost_id!r} version={version_id!r}: {e}"
            ) from e

    def set_distribution_state(
        self, dist_id: int, state: str, error: Optional[str] = None
    ) -> None:
        """transition a distribution to a new state."""
        with self._txn() as conn:
            conn.execute(
                '''UPDATE distributions
                   SET state = ?, updated_at = ?, error = ?
                   WHERE id = ?''',
                (state, _now(), error, dist_id),
            )

    def get_distribution(self, dist_id: int) -> Optional[sqlite3.Row]:
        """fetch a distribution row by id, or None if not found."""
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                'SELECT * FROM distributions WHERE id = ?', (dist_id,)
            )
            return cur.fetchone()

    def find_distribution(
        self, site_id: str, roost_id: str, version_id: str
    ) -> Optional[sqlite3.Row]:
        """fetch a distribution by natural key."""
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT * FROM distributions
                   WHERE site_id = ? AND roost_id = ? AND version_id = ?''',
                (site_id, roost_id, version_id),
            )
            return cur.fetchone()

    def list_pending_distributions(self) -> List[sqlite3.Row]:
        """
        list distributions in non-terminal states. called at agent startup
        to resume in-flight syncs after a crash/restart.
        """
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT * FROM distributions
                   WHERE state IN ('pending', 'downloading', 'verifying', 'assembling')
                   ORDER BY created_at ASC'''
            )
            return list(cur.fetchall())

    def list_scrub_due(self, max_age_seconds: int) -> List[sqlite3.Row]:
        """
        list committed distributions due for scrub: extract_root is set AND
        (last_scrub_at is NULL OR last_scrub_at < now - max_age_seconds).

        ordered oldest-scrub-first so a backlog drains in priority order.
        """
        with self._lock:
            assert self._conn is not None
            cutoff = _now() - max_age_seconds
            cur = self._conn.execute(
                '''SELECT * FROM distributions
                   WHERE state = 'committed'
                     AND extract_root IS NOT NULL
                     AND (last_scrub_at IS NULL OR last_scrub_at < ?)
                   ORDER BY COALESCE(last_scrub_at, 0) ASC''',
                (cutoff,),
            )
            return list(cur.fetchall())

    def mark_scrubbed(self, dist_id: int, scrubbed_at: Optional[int] = None) -> None:
        """update last_scrub_at on a distribution after a successful scrub run."""
        ts = scrubbed_at if scrubbed_at is not None else _now()
        with self._txn() as conn:
            conn.execute(
                'UPDATE distributions SET last_scrub_at = ? WHERE id = ?',
                (ts, dist_id),
            )

    # ─── chunks ───────────────────────────────────────────────────────

    def list_chunks(
        self, dist_id: int, state: Optional[str] = None
    ) -> List[sqlite3.Row]:
        """list chunks for a distribution, optionally filtered by state."""
        with self._lock:
            assert self._conn is not None
            if state is None:
                cur = self._conn.execute(
                    'SELECT * FROM chunks WHERE distribution_id = ?', (dist_id,)
                )
            else:
                cur = self._conn.execute(
                    '''SELECT * FROM chunks
                       WHERE distribution_id = ? AND state = ?''',
                    (dist_id, state),
                )
            return list(cur.fetchall())

    def set_chunk_state(
        self,
        dist_id: int,
        chunk_hash: str,
        state: str,
        error: Optional[str] = None,
        increment_attempts: bool = False,
    ) -> None:
        """transition a chunk's state. optionally increments retry counter."""
        with self._txn() as conn:
            if increment_attempts:
                conn.execute(
                    '''UPDATE chunks
                       SET state = ?, error = ?, attempts = attempts + 1
                       WHERE distribution_id = ? AND hash = ?''',
                    (state, error, dist_id, chunk_hash),
                )
            else:
                conn.execute(
                    '''UPDATE chunks
                       SET state = ?, error = ?
                       WHERE distribution_id = ? AND hash = ?''',
                    (state, error, dist_id, chunk_hash),
                )

    # ─── files ────────────────────────────────────────────────────────

    def list_files(
        self, dist_id: int, state: Optional[str] = None
    ) -> List[sqlite3.Row]:
        """list files for a distribution, optionally filtered by state."""
        with self._lock:
            assert self._conn is not None
            if state is None:
                cur = self._conn.execute(
                    'SELECT * FROM files WHERE distribution_id = ?', (dist_id,)
                )
            else:
                cur = self._conn.execute(
                    '''SELECT * FROM files
                       WHERE distribution_id = ? AND state = ?''',
                    (dist_id, state),
                )
            return list(cur.fetchall())

    def set_file_state(
        self,
        dist_id: int,
        path: str,
        state: str,
        error: Optional[str] = None,
    ) -> None:
        """transition a file's state."""
        with self._txn() as conn:
            conn.execute(
                '''UPDATE files
                   SET state = ?, error = ?
                   WHERE distribution_id = ? AND path = ?''',
                (state, error, dist_id, path),
            )

    # ─── progress aggregation ─────────────────────────────────────────

    def progress_summary(self, dist_id: int) -> dict:
        """
        return a summary suitable for sending to firestore as the agent's
        reported state. throttled by the caller (see firebase_client).
        """
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT state, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
                   FROM chunks WHERE distribution_id = ? GROUP BY state''',
                (dist_id,),
            )
            chunk_stats = {row['state']: dict(n=row['n'], bytes=row['bytes'])
                           for row in cur.fetchall()}
            cur = self._conn.execute(
                'SELECT state, COUNT(*) AS n FROM files WHERE distribution_id = ? GROUP BY state',
                (dist_id,),
            )
            file_stats = {row['state']: row['n'] for row in cur.fetchall()}
            return {'chunks': chunk_stats, 'files': file_stats}


def _now() -> int:
    """seconds since epoch as integer (sqlite-friendly)."""
    return int(time.time())
