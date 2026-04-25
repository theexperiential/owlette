"""
sync_assembler — atomic file reassembly for roost (project distribution v2).

reads chunks from the local content store, concatenates them into a
target file at `<extract_root>/<version_path>`, and atomically renames
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
- version fetch (sync_version)
- HTTP / network anything
- ACL hardening of extracted files (wave 4b.3 — extends this)
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Set

from destination_allowlist import (
    DestinationAllowlist,
    DestinationNotAllowedError,
)
from sync_downloader import chunk_path, _default_content_store
from sync_version import VersionFile
from sync_state import SyncState

logger = logging.getLogger(__name__)

# kept in sync with sync_downloader.DEFAULT_CONTENT_STORE — see
# sync_downloader._default_content_store() for the canonical resolver.
DEFAULT_CONTENT_STORE = _default_content_store()

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
    files: Iterable[VersionFile],
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
    # recompute each call so env-var overrides in tests are honored; see
    # sync_downloader.download_all for the matching pattern.
    if content_store is None:
        store = Path(_default_content_store())
    else:
        store = Path(os.path.expanduser(content_store))

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
                version_file=f,
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

    # post-assembly cleanup: delete chunks referenced by this version from the
    # content store. once a file has been atomically renamed into the extract
    # location AND committed in the state DB, the chunks are pure duplication —
    # R2 retains the authoritative copies, and a future re-sync or rollback
    # re-downloads. for a 100GB roost this avoids 100GB of redundant disk usage.
    #
    # we only scope the delete to chunks referenced by THIS version so that
    # if another distribution is mid-download against the same content store,
    # its chunks stay untouched. slow commands are serialized in the agent
    # command loop, so concurrent distributions are rare — this is
    # belt-and-suspenders in case the contract changes.
    #
    # skipped on external cancellation (chunks may still be needed on resume)
    # and on "nothing happened" runs where every file was a skip — no point
    # churning the cache for idempotent re-runs.
    if not result.cancelled and assembled > 0:
        chunks_to_cleanup = {
            c.hash
            for f in files_list
            for c in f.chunks
        }
        _cleanup_content_store(store, chunks_to_cleanup)

    return result


def _assemble_one(
    distribution_id: int,
    version_file: VersionFile,
    extract_root: Path,
    allowlist: DestinationAllowlist,
    state: SyncState,
    content_store: Path,
) -> bool:
    """
    assemble ONE file. returns True if a write occurred, False if the file
    was already present + matching (idempotent skip).
    """
    # build the target path. POSIX-style version path is normalized to
    # the local OS separator; allowlist.validate() handles the security
    # checks (path traversal, ADS, reserved names, etc).
    target_relative = Path(*version_file.path.split('/'))
    target_str = str(extract_root / target_relative)
    resolved_target = allowlist.validate(target_str)

    # idempotent skip: if the target file already exists and its size
    # matches AND it has the right total bytes, assume it's good.
    # (full-content verification is the scrub's job, not the hot-path
    # assembler — wave 4b.7 handles periodic re-verification.)
    if resolved_target.exists():
        try:
            if resolved_target.stat().st_size == version_file.size:
                # Re-harden ACL even on skip — an operator re-sync after
                # an agent upgrade is how stale DACLs (e.g. pre-operator-ACE
                # hardening from earlier builds) get fixed. _harden_acl is
                # a single syscall; cheap enough to run unconditionally.
                _harden_acl(_long_path(str(resolved_target)))
                state.set_file_state(distribution_id, version_file.path, 'committed')
                logger.debug(f"sync_assembler: {version_file.path!r} already present + matches size")
                return False
        except OSError:
            pass  # fall through to reassemble

    state.set_file_state(distribution_id, version_file.path, 'assembling')

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
            for chunk in version_file.chunks:
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

        if bytes_written != version_file.size:
            raise AssembleError(
                f"size mismatch: wrote {bytes_written} bytes, version says {version_file.size}"
            )

        # atomic rename. on windows, os.replace uses MoveFileExW with
        # MOVEFILE_REPLACE_EXISTING; on POSIX it's rename(2).
        os.replace(partial_str, target_str)

        # post-rename realpath check (wave 4b.2 — TOCTOU defense).
        # allowlist.validate() ran before the rename, but a privileged
        # attacker could swap an intermediate parent dir to a symlink or
        # junction in the window between validate and rename. resolve the
        # target AFTER the rename lands and confirm it still sits under
        # the expected extract_root. fail-closed: on mismatch, delete the
        # file and raise. do NOT keep a potentially-exfiltrated file on
        # disk.
        _verify_under_root(resolved_target, extract_root)

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

        state.set_file_state(distribution_id, version_file.path, 'committed')
        logger.debug(
            f"sync_assembler: {version_file.path!r} assembled "
            f"({bytes_written} bytes, {len(version_file.chunks)} chunks)"
        )
        return True

    except Exception:
        # leave the .partial in place — sync_state knows the file is in
        # 'assembling' state and the next run will retry. forcing a
        # cleanup here would lose the resume opportunity.
        raise


# ─── post-assembly chunk cleanup ────────────────────────────────────


def _cleanup_content_store(content_store: Path, chunks_to_cleanup: Set[str]) -> None:
    """
    best-effort delete of every chunk in `chunks_to_cleanup` from the content
    store. iterates one chunk at a time; a failed delete logs a warning but
    does NOT fail the sync — the assembled file is already on disk and
    that's what matters.

    we explicitly do NOT remove the shard parent dirs or the content-store
    root. a future sync will download fresh chunks into the same directory
    structure; removing the root would just force a re-mkdir on the next
    run. empty shard dirs are harmless (a few bytes of inode overhead each)
    and NTFS handles orphan directories fine.

    callers should only invoke this on SUCCESSFUL assembly — deleting chunks
    before the last file is committed would require re-downloading on any
    retry.
    """
    deleted = 0
    total_bytes = 0
    failed = 0
    for chunk_hash in chunks_to_cleanup:
        path = chunk_path(content_store, chunk_hash)
        try:
            # stat before unlink so we can report freed bytes. missing_ok
            # handles the race where the chunk was never downloaded (skip-
            # worthy dedup hit against a prior sync that already cleaned up).
            if path.exists():
                try:
                    total_bytes += path.stat().st_size
                except OSError:
                    pass
                path.unlink()
                deleted += 1
        except OSError as e:
            # don't fail the sync — log and move on. a leftover chunk is a
            # wasted disk page, not a correctness issue.
            failed += 1
            logger.warning(
                f"sync_assembler: failed to delete cached chunk "
                f"{chunk_hash[:12]}… at {path!s}: {e}"
            )
    if deleted or failed:
        # format bytes freed in human-friendly units for log readability
        # (100GB syncs make the raw byte count unwieldy).
        freed_mb = total_bytes / (1024 * 1024)
        logger.info(
            f"sync_assembler: cleaned up {deleted} chunk(s) from content store "
            f"({freed_mb:.1f} MiB freed); {failed} delete(s) failed"
        )


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


def _verify_under_root(resolved_target: 'Path', extract_root: 'Path') -> None:
    """
    confirm that `resolved_target` still lives under `extract_root` after the
    atomic rename has landed. closes the TOCTOU window between
    destination_allowlist.validate() and os.replace() — if a parent dir was
    swapped to a symlink/junction during that window, the file would appear
    to be under the root by path but resolve elsewhere.

    on mismatch: best-effort delete of the suspect file and raise
    AssembleError. we intentionally do NOT leave the file on disk — a
    successful post-rename that points outside the root is a strong signal
    of active tampering.

    uses os.path.realpath (resolves symlinks AND junctions on windows) with
    case-folded comparison on windows (NTFS is case-insensitive).
    """
    try:
        real_target = os.path.realpath(str(resolved_target))
        real_root = os.path.realpath(str(extract_root))
    except (OSError, ValueError) as e:
        # fail-closed: can't verify → delete + raise.
        _quarantine_delete(resolved_target)
        raise AssembleError(
            f"post-rename realpath failed for {str(resolved_target)!r}: {e}"
        ) from e

    if os.name == 'nt':
        real_target_cmp = real_target.casefold()
        real_root_cmp = real_root.casefold()
    else:
        real_target_cmp = real_target
        real_root_cmp = real_root

    # ensure the real root ends with a separator for unambiguous prefix match
    # (`/foo/bar` must not match root `/foo/ba`). str comparison, so normalize
    # the separator and append.
    root_with_sep = real_root_cmp.rstrip(os.sep) + os.sep
    if not (real_target_cmp + os.sep).startswith(root_with_sep):
        _quarantine_delete(resolved_target)
        raise AssembleError(
            f"post-rename integrity check failed: {str(resolved_target)!r} "
            f"resolves to {real_target!r}, outside extract_root {real_root!r}. "
            f"possible symlink/junction tampering — file quarantined."
        )


def _quarantine_delete(path: 'Path') -> None:
    """
    best-effort delete of a file whose post-rename location is suspect.
    errors are swallowed (logged only) — the caller is about to raise and
    the higher priority is that no caller acts on the file.
    """
    try:
        p = path if isinstance(path, Path) else Path(str(path))
        if p.exists():
            p.unlink()
    except OSError as e:
        logger.error(
            f"sync_assembler: failed to quarantine-delete {str(path)!r}: {e}. "
            f"MANUAL CLEANUP REQUIRED."
        )


def _harden_acl(path_str: str) -> None:
    """
    set explicit DACL: SYSTEM (full) + Administrators (full) + the
    interactive operator (modify, if detectable), inheritance stripped.
    windows-only; no-op on POSIX. best-effort: failure logs a warning
    but doesn't raise (the file is on disk, show must keep playing).

    win32security is deferred-imported so test environments without pywin32
    can still load this module. ImportError → skip silently (covered by the
    fail-soft contract; not a security regression because the threat model
    assumes ACLs land on production machines that have pywin32 installed).

    threat addressed (B-class baseline): default windows ACL inheritance on
    multi-user kiosks would let ANY local user read/modify assembled .toe
    files (potential malicious-payload swap or IP exfiltration). We scope
    access to SYSTEM + admins + the single operator account.

    UX requirement: the interactive user must be able to open extracted
    files from their desktop session (Photos, TouchDesigner, file
    explorer) without elevation. Admins-group membership isn't enough on
    Win10/11 because UAC hands non-elevated processes a filtered token
    with the Admins SID stripped — without an explicit user ACE, those
    processes see ACCESS_DENIED.
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
        # build a fresh DACL: SYSTEM + Administrators full control, the
        # interactive operator (if detected) MODIFY. No other ACEs —
        # everyone else is implicitly denied since DACL is now exclusive.
        dacl = ws.ACL()
        system_sid, _, _ = ws.LookupAccountName('', 'SYSTEM')
        admins_sid, _, _ = ws.LookupAccountName('', 'Administrators')
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, system_sid)
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, admins_sid)

        # Grant the operator MODIFY (read + write + delete, NOT take
        # ownership / change permissions). Best-effort: if the username
        # can't be resolved the DACL still works, just without the
        # user-specific ACE — same as the pre-UX-fix behaviour.
        try:
            from destination_allowlist import get_interactive_username
            username = get_interactive_username()
        except ImportError:
            username = None
        if username:
            try:
                user_sid, _, _ = ws.LookupAccountName('', username)
                # MODIFY = read+write+delete. Excludes WRITE_DAC (change
                # perms) and WRITE_OWNER so the operator can't undo the
                # hardening. Matches Windows "Modify" permission set.
                MODIFY = (
                    ntcon.FILE_GENERIC_READ
                    | ntcon.FILE_GENERIC_WRITE
                    | ntcon.FILE_GENERIC_EXECUTE
                    | ntcon.DELETE
                )
                dacl.AddAccessAllowedAce(ws.ACL_REVISION, MODIFY, user_sid)
            except Exception as e:
                # LookupAccountName fails on detached / renamed accounts.
                # Log once per file — rare and the user can still open via
                # an elevated shell; better than failing the whole sync.
                logger.warning(
                    f"sync_assembler: couldn't add operator {username!r} to DACL "
                    f"for {path_str!r}: {e}"
                )

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
