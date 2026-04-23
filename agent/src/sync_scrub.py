"""
sync_scrub — periodic on-disk integrity verification for roost (wave 4b.7).

walks the most recent committed manifest for each synced folder, re-hashes
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
- per-distribution; only scrubs the CURRENT manifest. older immutable
  manifests aren't scrubbed (their files may have been overwritten by
  later distributions, which is expected).
- chunked SHA-256 (no whole-file load) so a 50GB file doesn't OOM the agent.
- skips files in 'failed' state (already known broken — no need to re-confirm).

NOT this module's job:
- triggering the scrub (separate cron / scheduled task)
- repairing detected drift (operator decides; could trigger a re-pull)
- garbage collecting old manifests (chunk GC is wave 2b.4, server-side)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional

from sync_manifest import Manifest, ManifestFile, fetch_manifest, ManifestError
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


@dataclass
class FileDrift:
    """one drift entry: a file that doesn't match its manifest entry."""
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
    folder_id: str
    manifest_id: str
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
    against its manifest. returns a ScrubReport. caller persists/uploads it.

    extract_root is required because the manifest doesn't store the customer's
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

    # fetch manifest from cache (same one sync_assembler used to write the files)
    try:
        manifest = fetch_manifest(
            dist_row['manifest_url'],
            expected_manifest_id=dist_row['manifest_id'],
        )
    except ManifestError as e:
        raise ValueError(
            f"could not load manifest {dist_row['manifest_id']!r} for scrub: {e}"
        ) from e

    # which files to skip (already known failed)?
    failed_paths = {row['path'] for row in state.list_files(distribution_id, state='failed')}

    drifts: List[FileDrift] = []
    files_checked = 0
    files_skipped = 0
    extract_path = Path(os.path.expanduser(extract_root))
    for f in manifest.files:
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
        folder_id=dist_row['folder_id'],
        manifest_id=dist_row['manifest_id'],
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


def _check_file(extract_root: Path, manifest_file: ManifestFile) -> Optional[FileDrift]:
    """
    verify one file's on-disk contents match the manifest. returns None
    on match, a FileDrift entry on mismatch.

    re-hashes the file CONTENTS (not size+mtime). catches:
    - missing files
    - size mismatches (truncation, partial assembly)
    - hash mismatches (silent bit-rot, av interference, manual edit)
    - permission errors / read failures
    """
    target_relative = Path(*manifest_file.path.split('/'))
    target = extract_root / target_relative

    if not target.exists():
        return FileDrift(
            path=manifest_file.path,
            expected_size=manifest_file.size,
            actual_size=None,
            reason='missing',
        )

    try:
        actual_size = target.stat().st_size
    except OSError as e:
        return FileDrift(
            path=manifest_file.path, expected_size=manifest_file.size,
            actual_size=None, reason='read_error', error=f"stat: {e}",
        )

    if actual_size != manifest_file.size:
        return FileDrift(
            path=manifest_file.path, expected_size=manifest_file.size,
            actual_size=actual_size, reason='size_mismatch',
        )

    # hash the file contents in chunks. compute the FILE-level SHA-256 by
    # concatenating each chunk's hash? no — that's not how we computed the
    # manifest. the manifest stores PER-CHUNK hashes; we need to slice
    # the file the same way and verify each chunk independently.
    try:
        if not _verify_chunks(target, manifest_file):
            return FileDrift(
                path=manifest_file.path, expected_size=manifest_file.size,
                actual_size=actual_size, reason='hash_mismatch',
            )
    except OSError as e:
        return FileDrift(
            path=manifest_file.path, expected_size=manifest_file.size,
            actual_size=actual_size, reason='read_error', error=f"read: {e}",
        )

    return None


def _verify_chunks(target: Path, manifest_file: ManifestFile) -> bool:
    """
    open the file, slice it into chunks of the SAME sizes as the manifest
    declares, and verify each chunk's SHA-256 matches the manifest entry.

    returns True if every chunk matches; False on first mismatch (early exit
    saves time on large corrupted files).
    """
    with open(target, 'rb') as f:
        for i, chunk in enumerate(manifest_file.chunks):
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


def _write_report(report: ScrubReport, report_dir: str) -> None:
    """
    write the scrub report as JSON for local debugging + replay.

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
