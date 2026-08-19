"""
sync_scrub — periodic on-disk integrity verification for roost (wave 4b.7).

walks the most recent committed version for each roost, re-hashes
every assembled file's CONTENTS (not just size + mtime — that's syncthing's
mistake; silent bit-rot on never-modified files goes undetected with mtime
alone), and reports drift to firestore so the dashboard surfaces "machine
X has corrupted file Y".

design:
- runs from a separate scheduler (windows scheduled task or agent's own
  cron, wired up at install time). NOT triggered by the main loop.
- one ScrubReport per scrub run, written to firestore + local json file
  for debugging. report contains the (file_path, expected_hash, actual_hash,
  size, error?) for every drift.
- per-distribution; only scrubs the CURRENT version. older immutable
  versions aren't scrubbed (their files may have been overwritten by
  later distributions, which is expected).
- chunked SHA-256 (no whole-file load) so a 50GB file doesn't OOM the agent.
- skips files in 'failed' state (already known broken — no need to re-confirm).

also owns the LOCAL content-store reaper (`reap_orphan_chunks`): the
same walk-the-state-DB machinery answers "which cached chunks is nothing
waiting on any more", and something has to actually delete them — a failed
distribution otherwise keeps every byte it downloaded, forever.

NOT this module's job:
- triggering the scrub (separate cron / scheduled task)
- repairing detected drift (operator decides; could trigger a re-pull)
- garbage collecting old versions in R2 (chunk GC is wave 2b.4, server-side)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from sync_downloader import _default_content_store
from sync_version import Version, VersionFile, fetch_version, VersionError
from sync_state import SyncState

logger = logging.getLogger(__name__)

def _default_scrub_report_dir() -> str:
    """
    resolve the default scrub-report directory.

    windows: %PROGRAMDATA%\\Owlette\\scrub-reports
    POSIX:   $XDG_DATA_HOME/owlette/scrub-reports, else ~/.local/share/owlette/scrub-reports

    see sync_state._default_state_db_path() for why we avoid `~/Documents/`
    under LocalSystem.
    """
    if os.name == 'nt':
        program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')
        return os.path.join(program_data, 'Owlette', 'scrub-reports')
    xdg = os.environ.get('XDG_DATA_HOME')
    if xdg:
        return os.path.join(xdg, 'owlette', 'scrub-reports')
    return os.path.join(os.path.expanduser('~'), '.local', 'share', 'owlette', 'scrub-reports')


DEFAULT_SCRUB_REPORT_DIR = _default_scrub_report_dir()
_SCRUB_BUFFER_BYTES = 1024 * 1024  # 1 MiB read buffer

# retention for the JSON scrub reports. the agent dispatches a scrub every
# hour, so without a cap this directory gains a file per due distribution
# per run for the life of the machine. reports are a debugging aid — the
# recent ones are the useful ones.
MAX_SCRUB_REPORTS = 50
MAX_SCRUB_REPORT_AGE_SECONDS = 30 * 24 * 3600

# a cached chunk has to be this old before the reaper will touch it, even
# when the state DB says nothing references it. the gap covers the window
# between "sync_downloader wrote the blob" and "start_distribution / the
# chunk row is visible + the distribution is in an active state", plus any
# out-of-band writer we haven't thought of. 24h is far longer than any
# single distribution takes and still bounds the leak to one day.
DEFAULT_ORPHAN_MIN_AGE_SECONDS = 24 * 3600

# content-store filenames are the chunk's lowercase sha-256 hex digest,
# optionally with a `.partial` suffix while a download is in flight.
# anything else in the store was not written by us — leave it alone.
_CHUNK_NAME_RE = re.compile(r'^([0-9a-f]{64})(\.partial)?$')


@dataclass
class FileDrift:
    """one drift entry: a file that doesn't match its version entry."""
    path: str
    expected_size: int
    actual_size: Optional[int]  # None if file missing entirely
    reason: str  # 'missing', 'size_mismatch', 'hash_mismatch', 'read_error'
    error: Optional[str] = None  # populated for 'read_error'


@dataclass
class ScrubReport:
    """summary of one scrub run for one distribution."""
    distribution_id: int
    site_id: str
    roost_id: str
    version_id: str
    extract_root: str
    started_at: float
    finished_at: float
    files_checked: int
    files_skipped: int  # files in 'failed' state, skipped
    drifts: List[FileDrift] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return len(self.drifts) == 0


def scrub_distribution(
    distribution_id: int,
    extract_root: str,
    state: SyncState,
    report_dir: Optional[str] = None,
) -> ScrubReport:
    """
    re-verify the on-disk contents of every file from the given distribution
    against its version. returns a ScrubReport. caller persists/uploads it.

    extract_root is required because the version doesn't store the customer's
    extraction destination — that lives in the operator's config + the original
    sync_pull command payload. caller (the cron entry point) reads it from
    the same source.
    """
    started = time.time()
    dist_row = state.get_distribution(distribution_id)
    if dist_row is None:
        raise ValueError(f"distribution {distribution_id} not found in state")

    # only scrub committed distributions; in-flight ones are racing with
    # sync_assembler and would produce false drifts.
    if dist_row['state'] != 'committed':
        raise ValueError(
            f"distribution {distribution_id} is in state {dist_row['state']!r}; "
            f"only 'committed' distributions are scrub-eligible"
        )

    # fetch version from cache (same one sync_assembler used to write the files)
    try:
        version = fetch_version(
            dist_row['version_url'],
            expected_version_id=dist_row['version_id'],
        )
    except VersionError as e:
        raise ValueError(
            f"could not load version {dist_row['version_id']!r} for scrub: {e}"
        ) from e

    # which files to skip (already known failed)?
    failed_paths = {row['path'] for row in state.list_files(distribution_id, state='failed')}

    drifts: List[FileDrift] = []
    files_checked = 0
    files_skipped = 0
    extract_path = Path(os.path.expanduser(extract_root))
    for f in version.files:
        if f.path in failed_paths:
            files_skipped += 1
            continue
        files_checked += 1
        drift = _check_file(extract_path, f)
        if drift is not None:
            drifts.append(drift)

    finished = time.time()
    report = ScrubReport(
        distribution_id=distribution_id,
        site_id=dist_row['site_id'],
        roost_id=dist_row['roost_id'],
        version_id=dist_row['version_id'],
        extract_root=str(extract_path),
        started_at=started,
        finished_at=finished,
        files_checked=files_checked,
        files_skipped=files_skipped,
        drifts=drifts,
    )

    # persist the report locally (for debugging + replay). recompute the
    # default each call so a test env override (XDG_DATA_HOME) takes effect.
    _write_report(report, report_dir or _default_scrub_report_dir())

    if report.healthy:
        logger.info(
            f"sync_scrub: distribution {distribution_id} HEALTHY "
            f"({files_checked} files in {finished - started:.1f}s)"
        )
    else:
        logger.warning(
            f"sync_scrub: distribution {distribution_id} DRIFT — "
            f"{len(drifts)} of {files_checked} files mismatch"
        )

    return report


def _check_file(extract_root: Path, version_file: VersionFile) -> Optional[FileDrift]:
    """
    verify one file's on-disk contents match the version. returns None
    on match, a FileDrift entry on mismatch.

    re-hashes the file CONTENTS (not size+mtime). catches:
    - missing files
    - size mismatches (truncation, partial assembly)
    - hash mismatches (silent bit-rot, av interference, manual edit)
    - permission errors / read failures
    """
    target_relative = Path(*version_file.path.split('/'))
    target = extract_root / target_relative

    if not target.exists():
        return FileDrift(
            path=version_file.path,
            expected_size=version_file.size,
            actual_size=None,
            reason='missing',
        )

    try:
        actual_size = target.stat().st_size
    except OSError as e:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=None, reason='read_error', error=f"stat: {e}",
        )

    if actual_size != version_file.size:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=actual_size, reason='size_mismatch',
        )

    # hash the file contents in chunks. compute the FILE-level SHA-256 by
    # concatenating each chunk's hash? no — that's not how we computed the
    # version. the version stores PER-CHUNK hashes; we need to slice
    # the file the same way and verify each chunk independently.
    try:
        if not _verify_chunks(target, version_file):
            return FileDrift(
                path=version_file.path, expected_size=version_file.size,
                actual_size=actual_size, reason='hash_mismatch',
            )
    except OSError as e:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=actual_size, reason='read_error', error=f"read: {e}",
        )

    return None


def _verify_chunks(target: Path, version_file: VersionFile) -> bool:
    """
    open the file, slice it into chunks of the SAME sizes as the version
    declares, and verify each chunk's SHA-256 matches the version entry.

    returns True if every chunk matches; False on first mismatch (early exit
    saves time on large corrupted files).
    """
    with open(target, 'rb') as f:
        for i, chunk in enumerate(version_file.chunks):
            remaining = chunk.size
            h = hashlib.sha256()
            while remaining > 0:
                buf = f.read(min(_SCRUB_BUFFER_BYTES, remaining))
                if not buf:
                    return False  # short read — file truncated
                h.update(buf)
                remaining -= len(buf)
            if h.hexdigest() != chunk.hash:
                return False
    return True


def scrub_all_due(
    state: SyncState,
    max_age_seconds: int = 30 * 24 * 3600,  # 30 days
    report_dir: Optional[str] = None,
) -> List[ScrubReport]:
    """
    iterate every committed distribution whose last_scrub_at is older than
    max_age_seconds (or NULL — never scrubbed), run scrub_distribution on
    each, mark_scrubbed() on success.

    intended to be called periodically from the agent main loop (via the
    slow_command_worker thread, NOT the main loop itself — scrub may take
    minutes for large projects). a single call drains the backlog one at a
    time; failures don't stop subsequent distributions.

    returns the list of reports produced (caller can upload them to firestore
    or store for the dashboard).
    """
    due = state.list_scrub_due(max_age_seconds)
    if not due:
        logger.debug("sync_scrub: no distributions due for scrub")
        return []

    logger.info(f"sync_scrub: {len(due)} distribution(s) due for scrub")
    reports: List[ScrubReport] = []
    for row in due:
        try:
            report = scrub_distribution(
                row['id'], row['extract_root'], state, report_dir=report_dir,
            )
            reports.append(report)
            # mark_scrubbed even on drift — we DID scrub successfully; the
            # drift itself is reported separately. only fail-to-run skips
            # the mark so the next pass retries it.
            state.mark_scrubbed(row['id'])
        except (ValueError, OSError) as e:
            logger.error(
                f"sync_scrub: failed to scrub distribution {row['id']}: {e}"
            )
    return reports


# ─── content-store reaper ────────────────────────────────────────────


@dataclass
class ReapReport:
    """summary of one content-store reap pass."""
    scanned: int = 0            # chunk-shaped files examined
    deleted: int = 0            # orphans removed (or, in dry-run, selected)
    bytes_freed: int = 0
    kept_referenced: int = 0    # still needed by an in-flight distribution
    kept_recent: int = 0        # younger than min_age_seconds
    kept_unrecognized: int = 0  # not a chunk filename — never ours to delete
    failed: int = 0             # delete errors (locked file, ACL, AV)
    dry_run: bool = False
    deleted_hashes: List[str] = field(default_factory=list)


def reap_orphan_chunks(
    state: SyncState,
    content_store: Optional[str] = None,
    min_age_seconds: int = DEFAULT_ORPHAN_MIN_AGE_SECONDS,
    dry_run: bool = False,
) -> ReapReport:
    """
    delete cached chunks that no in-flight distribution needs any more.

    a chunk is reaped when BOTH hold:
      1. its hash is not referenced by a distribution in an active state
         (see sync_state.ACTIVE_DISTRIBUTION_STATES). committed / failed /
         cancelled rows are history — the assembler releases a committed
         distribution's chunks itself, and a failed one is never resumed.
      2. it is older than `min_age_seconds` (default 24h). this is the
         belt-and-braces guard: a distribution that has written blobs but
         hasn't registered its rows yet keeps its bytes regardless of what
         the state DB currently says.

    `.partial` sidecars are reaped under the same two rules — an abandoned
    partial download is exactly the leak this is here to stop.

    best-effort by construction: a file we cannot delete is counted and
    logged, never raised. returns a ReapReport for the caller to log or
    surface. `dry_run=True` selects and reports without deleting.
    """
    store = Path(os.path.expanduser(content_store or _default_content_store()))
    report = ReapReport(dry_run=dry_run)
    if not store.is_dir():
        logger.debug(f"sync_scrub: content store {store} does not exist — nothing to reap")
        return report

    referenced = state.list_referenced_chunk_hashes()
    cutoff = time.time() - max(0, min_age_seconds)

    for path, chunk_hash in _iter_content_store(store, report):
        report.scanned += 1
        if chunk_hash in referenced:
            report.kept_referenced += 1
            continue
        try:
            st = path.stat()
        except OSError:
            # vanished between scandir and stat — nothing to do.
            continue
        if st.st_mtime > cutoff:
            report.kept_recent += 1
            continue
        if dry_run:
            report.deleted += 1
            report.bytes_freed += st.st_size
            report.deleted_hashes.append(chunk_hash)
            continue
        try:
            path.unlink()
        except OSError as e:
            report.failed += 1
            logger.warning(
                f"sync_scrub: could not reap orphan chunk {path.name[:12]}… "
                f"at {path!s}: {e}"
            )
            continue
        report.deleted += 1
        report.bytes_freed += st.st_size
        report.deleted_hashes.append(chunk_hash)
        logger.debug(f"sync_scrub: reaped orphan chunk {path.name} ({st.st_size} bytes)")

    if report.deleted or report.failed:
        # sample the hashes so an operator can correlate the reap with a
        # specific distribution without turning on debug logging, but cap
        # it — a 125k-chunk store must not write 125k log lines.
        sample = ', '.join(h[:12] + '…' for h in report.deleted_hashes[:10])
        more = '' if len(report.deleted_hashes) <= 10 else f" (+{len(report.deleted_hashes) - 10} more)"
        verb = 'would reap' if dry_run else 'reaped'
        logger.info(
            f"sync_scrub: content-store reap — {verb} {report.deleted} orphan "
            f"chunk(s), {report.bytes_freed / (1024 * 1024):.1f} MiB; kept "
            f"{report.kept_referenced} referenced + {report.kept_recent} recent; "
            f"{report.failed} failed. hashes: {sample}{more}"
        )
    else:
        logger.debug(
            f"sync_scrub: content-store reap — nothing to collect "
            f"({report.scanned} chunk(s) scanned, {report.kept_referenced} referenced, "
            f"{report.kept_recent} too recent)"
        )
    return report


def _iter_content_store(store: Path, report: ReapReport) -> Iterable[Tuple[Path, str]]:
    """
    yield (path, chunk_hash) for every chunk-shaped file in the sharded
    content store (`<store>/<2 hex>/<64 hex>[.partial]`).

    anything that isn't a regular file with a chunk-shaped name is counted
    in `report.kept_unrecognized` and skipped — the reaper only ever deletes
    files it can prove it wrote. symlinks are skipped for the same reason.
    """
    try:
        with os.scandir(str(store)) as shards:
            shard_entries = list(shards)
    except OSError as e:
        logger.warning(f"sync_scrub: cannot list content store {store}: {e}")
        return
    for shard in shard_entries:
        try:
            if not shard.is_dir(follow_symlinks=False):
                report.kept_unrecognized += 1
                continue
            with os.scandir(shard.path) as it:
                entries = list(it)
        except OSError as e:
            logger.warning(f"sync_scrub: cannot list content-store shard {shard.path}: {e}")
            continue
        for entry in entries:
            try:
                if not entry.is_file(follow_symlinks=False):
                    report.kept_unrecognized += 1
                    continue
            except OSError:
                continue
            m = _CHUNK_NAME_RE.match(entry.name)
            if m is None:
                report.kept_unrecognized += 1
                continue
            yield Path(entry.path), m.group(1)


def _write_report(report: ScrubReport, report_dir: str) -> None:
    """
    write the scrub report as JSON for local debugging + replay, then trim
    the report directory so it can't grow without bound.

    best-effort: any error (mkdir failure, disk full, permission denied)
    logs a warning but does NOT raise — the in-memory report is still
    returned to the caller. the scrub itself isn't a critical-path op
    and an unwritable report dir shouldn't break the agent.
    """
    rd = Path(os.path.expanduser(report_dir))
    fname = f"scrub_{report.distribution_id}_{int(report.finished_at)}.json"
    target = rd / fname
    try:
        rd.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(asdict(report), indent=2),
            encoding='utf-8',
        )
    except OSError as e:
        logger.warning(f"sync_scrub: could not persist report to {target}: {e}")
        return
    _prune_old_reports(rd)


def _prune_old_reports(
    report_dir: Path,
    keep: int = MAX_SCRUB_REPORTS,
    max_age_seconds: int = MAX_SCRUB_REPORT_AGE_SECONDS,
) -> int:
    """
    delete scrub reports that are beyond the newest `keep` OR older than
    `max_age_seconds`. returns the number deleted.

    the agent scrubs on an hourly dispatch, so without this the report
    directory gains a file per due-distribution per run, forever — nothing
    else cleans it (shared_utils.cleanup_old_logs only walks the logs root
    and only matches `*.log`).

    only files matching our own `scrub_*.json` naming are considered, and
    every failure is swallowed: a report we can't delete is disk noise, not
    a reason to fail a scrub.
    """
    try:
        entries = [p for p in report_dir.glob('scrub_*.json') if p.is_file()]
    except OSError as e:
        logger.warning(f"sync_scrub: could not list report dir {report_dir}: {e}")
        return 0

    stamped = []
    for p in entries:
        try:
            stamped.append((p.stat().st_mtime, p))
        except OSError:
            continue
    stamped.sort(key=lambda t: t[0], reverse=True)  # newest first

    cutoff = time.time() - max_age_seconds
    deleted = 0
    for index, (mtime, path) in enumerate(stamped):
        if index < keep and mtime >= cutoff:
            continue
        try:
            path.unlink()
            deleted += 1
        except OSError as e:
            logger.warning(f"sync_scrub: could not delete old report {path}: {e}")
    if deleted:
        logger.info(
            f"sync_scrub: trimmed {deleted} old scrub report(s) from {report_dir} "
            f"(keeping the newest {keep} within {max_age_seconds // 86400}d)"
        )
    return deleted
