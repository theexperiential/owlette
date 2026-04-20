"""
sync_assembler — atomic file reassembly for roost (project distribution v2).

reads chunks from the local content store, concatenates them into a
target file at `<extract_root>/<manifest_path>`, and atomically renames
into place. NEVER overwrites a live file partially: writes go to a
`<path>.partial` sidecar, get fsynced, then replace the target via
`os.replace` (atomic on POSIX; uses ReplaceFileW on Windows under the
hood for python ≥3.3).

design:
- destination_allowlist gates EVERY target path before any disk write.
  fail-closed: empty allowlist rejects everything.
- per-file state tracked in SyncState; on resume, files in 'assembling'
  state get their `.partial` either continued or discarded.
- one Assembler instance handles a whole distribution; it doesn't keep
  thread state, so multiple distributions can have their own instances
  without contention.
- cancellation honored between files (NOT mid-file — a half-assembled
  file with the wrong size on disk would be confusing). cancel mid-rename
  is impossible (rename is atomic).
- runs as agent SYSTEM user; relies on destination_allowlist + the sync
  guard rails (no symlinks, no junctions, no ADS, no reserved names) to
  prevent customer-controlled-path → SYSTEM-write escalation.

NOT this module's job:
- chunk download (sync_downloader)
- manifest fetch (sync_manifest)
- HTTP / network anything
- ACL hardening of extracted files (wave 4b.3 — extends this)
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

from destination_allowlist import (
    DestinationAllowlist,
    DestinationNotAllowedError,
)
from sync_downloader import chunk_path
from sync_manifest import ManifestFile
from sync_state import SyncState

logger = logging.getLogger(__name__)

DEFAULT_CONTENT_STORE = '~/Documents/Owlette/.owlette-content'

# read buffer for streaming chunks into the target file. small enough to
# avoid OOM on 50GB files; large enough to keep IO efficient.
_ASSEMBLE_BUFFER_BYTES = 1024 * 1024  # 1 MiB

# windows MAX_PATH; paths at or beyond this length need the `\\?\` prefix
# to be addressable by win32 file APIs even when LongPathsEnabled is set
# in the registry, because some win32 APIs still cap at 260 without it.
_WINDOWS_MAX_PATH = 260


class AssembleError(Exception):
    """raised when assembly fails for reasons callers must surface."""
    pass


@dataclass
class AssembleResult:
    assembled: int   # files newly written this run
    skipped: int     # files already present + matching (idempotent re-runs)
    failed: int      # files that errored
    cancelled: bool


def assemble_all(
    distribution_id: int,
    files: Iterable[ManifestFile],
    extract_root: str,
    state: SyncState,
    allowlist: DestinationAllowlist,
    cancel_event: Optional[threading.Event] = None,
    content_store: Optional[str] = None,
) -> AssembleResult:
    """
    assemble every file from chunks into `extract_root/<file.path>`.

    extract_root: the customer-configured destination (e.g. `C:\\TouchDesigner\\Projects`).
    allowlist: pre-built DestinationAllowlist; assembler validates each
    target path against it before any write.
    cancel_event: checked between files. cancel during write is NOT honored
    (atomic-rename safety) — wait until current file completes.

    raises AssembleError on first failure if cancel_event is None
    (caller can decide to keep going by passing a cancel_event).
    """
    if cancel_event is None:
        cancel_event = threading.Event()
    store = Path(os.path.expanduser(content_store or DEFAULT_CONTENT_STORE))

    # validate the extract_root itself BEFORE doing any disk work. this
    # catches misconfiguration loud and early instead of failing per-file.
    try:
        resolved_root = allowlist.validate(extract_root)
    except DestinationNotAllowedError as e:
        raise AssembleError(
            f"extract_root not allowed by destination_allowlist: {e}"
        ) from e

    files_list = list(files)
    assembled = 0
    skipped = 0
    failed = 0
    # snapshot BEFORE any per-file failure flips cancel_event ourselves.
    # lets us distinguish "user cancelled" from "failure short-circuit".
    was_externally_cancelled = cancel_event.is_set()

    for f in files_list:
        if cancel_event.is_set():
            logger.info(
                f"sync_assembler: distribution {distribution_id} cancelled "
                f"after {assembled} assembled, {skipped} skipped"
            )
            break
        try:
            did_write = _assemble_one(
                distribution_id=distribution_id,
                manifest_file=f,
                extract_root=resolved_root,
                allowlist=allowlist,
                state=state,
                content_store=store,
            )
            if did_write:
                assembled += 1
            else:
                skipped += 1
        except (AssembleError, DestinationNotAllowedError, OSError) as e:
            failed += 1
            logger.error(
                f"sync_assembler: failed to assemble {f.path!r}: {e}",
                exc_info=True,
            )
            state.set_file_state(
                distribution_id, f.path, 'failed',
                error=f"{type(e).__name__}: {e}",
            )
            cancel_event.set()  # short-circuit remaining files

    result = AssembleResult(
        assembled=assembled, skipped=skipped, failed=failed,
        cancelled=was_externally_cancelled and failed == 0,
    )
    logger.info(
        f"sync_assembler: distribution {distribution_id}: "
        f"assembled={assembled} skipped={skipped} failed={failed} "
        f"cancelled={result.cancelled}"
    )
    # failure always raises so the caller gets a hard error. external
    # cancellation returns peacefully (result.cancelled tells the story).
    if failed > 0:
        raise AssembleError(
            f"distribution {distribution_id}: {failed} file(s) failed to assemble"
        )
    return result


def _assemble_one(
    distribution_id: int,
    manifest_file: ManifestFile,
    extract_root: Path,
    allowlist: DestinationAllowlist,
    state: SyncState,
    content_store: Path,
) -> bool:
    """
    assemble ONE file. returns True if a write occurred, False if the file
    was already present + matching (idempotent skip).
    """
    # build the target path. POSIX-style manifest path is normalized to
    # the local OS separator; allowlist.validate() handles the security
    # checks (path traversal, ADS, reserved names, etc).
    target_relative = Path(*manifest_file.path.split('/'))
    target_str = str(extract_root / target_relative)
    resolved_target = allowlist.validate(target_str)

    # idempotent skip: if the target file already exists and its size
    # matches AND it has the right total bytes, assume it's good.
    # (full-content verification is the scrub's job, not the hot-path
    # assembler — wave 4b.7 handles periodic re-verification.)
    if resolved_target.exists():
        try:
            if resolved_target.stat().st_size == manifest_file.size:
                state.set_file_state(distribution_id, manifest_file.path, 'committed')
                logger.debug(f"sync_assembler: {manifest_file.path!r} already present + matches size")
                return False
        except OSError:
            pass  # fall through to reassemble

    state.set_file_state(distribution_id, manifest_file.path, 'assembling')

    # write to a `.partial` sidecar so a crash mid-write leaves the live
    # file (if any) untouched.
    partial = resolved_target.with_suffix(resolved_target.suffix + '.partial')
    # _ensure_parent_dir handles long-path prefix for mkdir on windows.
    _ensure_parent_dir(resolved_target)

    # use long-path-prefixed strings for win32 file APIs when the path
    # would exceed MAX_PATH. open() / os.replace / os.fsync all accept
    # the `\\?\` prefix on windows.
    partial_str = _long_path(str(partial))
    target_str = _long_path(str(resolved_target))

    bytes_written = 0
    try:
        with open(partial_str, 'wb') as out:
            for chunk in manifest_file.chunks:
                src = chunk_path(content_store, chunk.hash)
                if not src.exists():
                    raise AssembleError(
                        f"chunk {chunk.hash[:12]}… missing from content store; "
                        f"download must complete before assembly"
                    )
                with open(src, 'rb') as src_f:
                    while True:
                        buf = src_f.read(_ASSEMBLE_BUFFER_BYTES)
                        if not buf:
                            break
                        out.write(buf)
                        bytes_written += len(buf)
            # flush + fsync so power loss between rename and the data
            # actually hitting disk doesn't corrupt the file.
            out.flush()
            try:
                os.fsync(out.fileno())
            except OSError as e:
                # fsync can fail on remote filesystems; log + continue.
                logger.warning(
                    f"sync_assembler: fsync failed for {partial}: {e}"
                )

        if bytes_written != manifest_file.size:
            raise AssembleError(
                f"size mismatch: wrote {bytes_written} bytes, manifest says {manifest_file.size}"
            )

        # atomic rename. on windows, os.replace uses MoveFileExW with
        # MOVEFILE_REPLACE_EXISTING; on POSIX it's rename(2).
        os.replace(partial_str, target_str)

        # fsync the parent directory so the rename itself is durable. on
        # windows this is a no-op (rename via MoveFileEx handles it).
        if os.name == 'posix':
            dir_fd = os.open(str(resolved_target.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)

        # harden the ACL: SYSTEM + Administrators only, inheritance stripped.
        # best-effort + windows-only; log on failure but don't fail the assembly
        # (the file is on disk and the show needs to play).
        _harden_acl(target_str)

        state.set_file_state(distribution_id, manifest_file.path, 'committed')
        logger.debug(
            f"sync_assembler: {manifest_file.path!r} assembled "
            f"({bytes_written} bytes, {len(manifest_file.chunks)} chunks)"
        )
        return True

    except Exception:
        # leave the .partial in place — sync_state knows the file is in
        # 'assembling' state and the next run will retry. forcing a
        # cleanup here would lose the resume opportunity.
        raise


# ─── windows long-path support ───────────────────────────────────────


def _long_path(path: str) -> str:
    """
    on windows, prefix a path with `\\?\` if it's at or above MAX_PATH (260)
    so win32 file APIs don't reject it. behavior is a no-op on POSIX and
    on short paths.

    requirements for `\\?\` to work:
    - path must be absolute and fully-resolved (no `..`, no `.`)
      → guaranteed by destination_allowlist.validate() before we get here
    - path must use backslashes (forward slashes are NOT auto-converted)
    - already-prefixed paths are passed through unchanged
    """
    if os.name != 'nt':
        return path
    if path.startswith('\\\\?\\') or path.startswith('\\\\.\\'):
        return path
    if len(path) < _WINDOWS_MAX_PATH:
        return path
    # absolutize backslashes; \\?\ works only with backslash paths
    normalized = path.replace('/', '\\')
    # UNC paths get a different prefix: \\?\UNC\server\share\... (NOT \\?\\\server\share)
    if normalized.startswith('\\\\'):
        return '\\\\?\\UNC\\' + normalized[2:]
    return '\\\\?\\' + normalized


def _ensure_parent_dir(target: 'Path') -> None:
    """
    create target.parent (mkdir -p), with long-path support on windows.
    Path.mkdir doesn't accept the `\\?\` prefix natively in older python,
    so we use os.makedirs on the prefixed string when the path is long.
    """
    parent = target.parent
    parent_str = str(parent)
    if os.name == 'nt' and len(parent_str) >= _WINDOWS_MAX_PATH:
        os.makedirs(_long_path(parent_str), exist_ok=True)
    else:
        parent.mkdir(parents=True, exist_ok=True)


def _harden_acl(path_str: str) -> None:
    """
    set explicit DACL: SYSTEM (full) + Administrators (full), inheritance
    stripped. windows-only; no-op on POSIX. best-effort: failure logs a
    warning but doesn't raise (the file is on disk, show must keep playing).

    win32security is deferred-imported so test environments without pywin32
    can still load this module. ImportError → skip silently (covered by the
    fail-soft contract; not a security regression because the threat model
    assumes ACLs land on production machines that have pywin32 installed).

    threat addressed (B-class baseline): default windows ACL inheritance on
    multi-user kiosks would let any local user read/modify assembled .toe
    files (potential malicious-payload swap or IP exfiltration).
    """
    if os.name != 'nt':
        return
    try:
        import win32security as ws
        import ntsecuritycon as ntcon
    except ImportError:
        # pywin32 not installed (test env on non-windows, etc.) — skip.
        return
    try:
        # build a fresh DACL: SYSTEM + Administrators get full control,
        # NO other ACEs (everyone else implicitly denied since DACL is exclusive).
        dacl = ws.ACL()
        system_sid, _, _ = ws.LookupAccountName('', 'SYSTEM')
        admins_sid, _, _ = ws.LookupAccountName('', 'Administrators')
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, system_sid)
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, admins_sid)

        sd = ws.GetFileSecurity(path_str, ws.DACL_SECURITY_INFORMATION)
        # SetSecurityDescriptorDacl(present=True, dacl=..., defaulted=False)
        sd.SetSecurityDescriptorDacl(1, dacl, 0)
        # strip inheritance with PROTECTED_DACL_SECURITY_INFORMATION. use the
        # pywin32 constant when available (correctly typed); fall back to the
        # raw bitmask coerced to int. literal 0x80000000 overflows a signed
        # C long on python 3.9 + 32-bit pywin32 builds.
        protected_dacl = getattr(ws, 'PROTECTED_DACL_SECURITY_INFORMATION', None)
        if protected_dacl is None:
            protected_dacl = int(0x80000000)
        ws.SetFileSecurity(
            path_str,
            ws.DACL_SECURITY_INFORMATION | protected_dacl,
            sd,
        )
    except Exception as e:
        logger.warning(f"sync_assembler: ACL hardening failed for {path_str!r}: {e}")
