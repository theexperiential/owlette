"""
destination_allowlist — security-floor enforcement for where roost will
write extracted files on this machine.

agents run as SYSTEM; without this allowlist, a customer-controlled
extract_path could overwrite C:\\Windows\\System32. fail-closed: if the
allowlist is empty or missing, NOTHING is allowed.

design principles:
- single source of truth: list of absolute, real-path-resolved root dirs.
- realpath check (not just startswith on the literal path) to defeat
  symlink/junction reparse-point escapes.
- on windows: detect both symlinks (IO_REPARSE_TAG_SYMLINK) and junctions
  (IO_REPARSE_TAG_MOUNT_POINT) via FILE_ATTRIBUTE_REPARSE_POINT — junctions
  are creatable without SeCreateSymbolicLinkPrivilege so are the more common
  attacker primitive (cve-2022-21658, cve-2025-4330 family).
- on windows: case-insensitive comparison for allowlist match (NTFS is
  case-insensitive; mismatched casing must NOT cause a false reject).
- raises DestinationNotAllowedError on rejection so callers can render
  clean error messages.

NOT this module's job:
- network or auth checks (handled upstream)
- chunk verification (sync_assembler responsibility)
- ACL setting on extracted files (sync_assembler responsibility)

reference: roost plan, wave 1.7. consumed by agent/src/sync_assembler.py
during atomic file rename.
"""

from __future__ import annotations

import logging
import os
import stat
import sys
from pathlib import Path
from typing import Any, Iterable, List, Optional

logger = logging.getLogger(__name__)

# default allowlist applied at install time when no explicit config is
# provided. matches the recommended owlette projects directory.
#
# `~` is expanded via `_safe_expanduser` below, NOT plain
# os.path.expanduser. When the agent runs as the Windows LocalSystem
# account (the default for the OwletteService), raw expansion would
# land in `C:\Windows\System32\config\systemprofile\...` — correctly
# rejected by `_is_dangerous_root` but leaving the allowlist empty.
# Safe expander resolves `~` to the interactive user's profile
# (auto-login user if set, else most-recently-active non-system profile)
# so files land where the operator expects — their own Documents folder —
# instead of stranded under Public.
#
# Root is `~/Documents` (not `~/Documents/Owlette`) so that user-specified
# relative extract paths like "projects/show1" resolve under Documents
# directly rather than nested inside `Documents/Owlette`. The default
# empty-field fallback still nests under `Owlette` — see the web-side
# `resolveExtractPath` helper for the resolution rules.
DEFAULT_ROOTS: List[str] = ['~/Documents']

# Last-resort home when running as SYSTEM and we can't identify any
# interactive user profile. `Public` is writable by SYSTEM, visible to
# every user in File Explorer, and not under System32.
_WINDOWS_SYSTEM_FALLBACK_HOME = r'C:\Users\Public'

# Windows user directories we must NEVER treat as the interactive user
# when scanning C:\Users\. Case-insensitive.
_WINDOWS_PROFILE_EXCLUDES = frozenset({
    'public', 'default', 'default user', 'defaultappgroup',
    'all users', 'systemprofile', 'networkservice', 'localservice',
})

# Memoised result of `_resolve_interactive_home` — the logged-in user
# doesn't change across a single service run on kiosk machines, so
# skip the registry + filesystem scan on every path expansion.
_cached_interactive_home: Optional[str] = None
_cached_interactive_home_sentinel = object()  # distinguish "not cached" from "cached None"
_cached_interactive_home_state: Any = _cached_interactive_home_sentinel


def _running_as_system() -> bool:
    """True when the current process is the Windows LocalSystem account."""
    if sys.platform != 'win32':
        return False
    # USERNAME is 'SYSTEM' under LocalSystem; USERPROFILE points at
    # the systemprofile dir. Checking USERPROFILE avoids false positives
    # from a real user literally named 'SYSTEM'.
    profile = os.environ.get('USERPROFILE', '')
    return 'system32' in profile.lower() and 'systemprofile' in profile.lower()


def _resolve_interactive_home() -> Optional[str]:
    """
    Find the primary interactive user's profile directory — the one an
    operator would expect `~` to resolve to on a kiosk / signage / media
    server. Resolution order:

      1. Auto-login user from HKLM\\…\\Winlogon\\DefaultUserName. Kiosks
         run with auto-login ("password never expires" is standard per
         the installation checklist), so this is the authoritative
         signal when present.
      2. Most-recently-modified profile under C:\\Users\\ excluding
         system / default / public. Covers workstations without auto-login.

    Returns None if nothing usable is found — caller falls back to
    C:\\Users\\Public. Never raises.
    """
    if sys.platform != 'win32':
        return None

    # 1. auto-login default user
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon',
        ) as k:
            try:
                name, _ = winreg.QueryValueEx(k, 'DefaultUserName')
                if isinstance(name, str) and name.strip():
                    # DefaultUserName can be `DOMAIN\user` — take the bare username.
                    bare = name.strip().split('\\')[-1]
                    candidate = Path('C:/Users') / bare
                    if candidate.is_dir():
                        resolved = str(candidate)
                        logger.info(
                            f"destination_allowlist: resolved `~` via auto-login "
                            f"DefaultUserName → {resolved}"
                        )
                        return resolved
            except FileNotFoundError:
                pass  # key exists but no DefaultUserName value
    except (OSError, ImportError):
        pass

    # 2. most recently modified non-system profile under C:\Users\
    try:
        users_dir = Path('C:/Users')
        best: Optional[tuple] = None  # (mtime, path)
        for entry in users_dir.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.lower() in _WINDOWS_PROFILE_EXCLUDES:
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if best is None or mtime > best[0]:
                best = (mtime, str(entry))
        if best is not None:
            logger.info(
                f"destination_allowlist: resolved `~` via most-recent-profile → {best[1]}"
            )
            return best[1]
    except OSError:
        pass

    return None


def get_interactive_username() -> Optional[str]:
    """
    Public accessor for the detected interactive username — the `admin`
    in `C:\\Users\\admin`, derived by `_resolve_interactive_home`.
    Used by the assembler to include the operator in file DACLs so
    extracted files are readable from the user's desktop session.

    Returns None when:
      - Not running on Windows, or
      - Not running as LocalSystem (no redirection happened), or
      - No interactive user could be identified (fell back to Public).

    In those cases the caller should keep its existing ACL policy
    without trying to add a user ACE.
    """
    if not _running_as_system():
        return None
    home = _get_interactive_home()
    if home == _WINDOWS_SYSTEM_FALLBACK_HOME:
        return None
    # Profile directory name equals the username in every mainstream
    # Windows configuration. DOMAIN\user profiles still resolve to
    # `C:\Users\user`, which is what LookupAccountName wants anyway.
    return Path(home).name or None


def _get_interactive_home() -> str:
    """Memoised wrapper around `_resolve_interactive_home` + fallback."""
    global _cached_interactive_home_state
    if _cached_interactive_home_state is _cached_interactive_home_sentinel:
        resolved = _resolve_interactive_home()
        if resolved is None:
            logger.warning(
                f"destination_allowlist: could not identify an interactive user "
                f"under C:\\Users\\ — falling back to {_WINDOWS_SYSTEM_FALLBACK_HOME!r}. "
                f"Files will be visible to every user but not under any specific "
                f"user's Documents."
            )
            resolved = _WINDOWS_SYSTEM_FALLBACK_HOME
        _cached_interactive_home_state = resolved
    return _cached_interactive_home_state


def _safe_expanduser(path: str) -> str:
    """
    Like `os.path.expanduser`, but under the Windows LocalSystem account
    we redirect `~` to the interactive user's profile (or C:\\Users\\Public
    as a last resort) instead of C:\\Windows\\System32\\config\\systemprofile.
    Other platforms and non-SYSTEM Windows users behave exactly like the
    stdlib.

    Only the leading `~` is substituted — a literal `~` in the middle of
    a path stays untouched, matching stdlib semantics.
    """
    if not path:
        return path
    if not _running_as_system():
        return os.path.expanduser(path)
    home = _get_interactive_home()
    if path == '~':
        return home
    if path.startswith('~/') or path.startswith('~\\'):
        return home + path[1:]
    # `~user/...` — let stdlib handle; if `user` doesn't exist, it leaves
    # the path unchanged (desired).
    return os.path.expanduser(path)

# windows: file attribute bit indicating any reparse point — covers BOTH
# IO_REPARSE_TAG_SYMLINK (symlinks) and IO_REPARSE_TAG_MOUNT_POINT
# (junctions). using attributes rather than is_symlink() which only
# catches symlinks.
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

# windows reserved device names — writing to ANY of these names (with or
# without an extension) redirects the i/o to the named device, NOT the
# file system. an attacker-controlled manifest path of `<allowed>/NUL`
# or `<allowed>/sub/CON.toe` silently corrupts data or attaches to console.
# https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
_WINDOWS_RESERVED_NAMES = frozenset({
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
})


class DestinationNotAllowedError(Exception):
    """raised when a destination path is outside the allowlist."""
    pass


class DestinationAllowlist:
    """
    holds a set of allowed root directories. validates whether a target
    path falls under one of them, post realpath resolution.

    construction:
        allowlist = DestinationAllowlist(['~/Documents/Owlette', 'D:\\Media'])

    or from config:
        allowlist = DestinationAllowlist.from_config(config_dict)
    """

    def __init__(self, roots: Optional[Iterable[str]]) -> None:
        # fail-closed: None or empty becomes empty list (rejects everything).
        # explicit empty allowlist is a deliberate "deny all" lockdown state.
        if roots is None:
            self._roots: List[Path] = []
        else:
            resolved: List[Path] = []
            for r in roots:
                if not r or not isinstance(r, str):
                    logger.warning(
                        f"destination_allowlist: ignoring invalid root entry: {r!r}"
                    )
                    continue
                try:
                    expanded = Path(_safe_expanduser(r)).resolve(strict=False)
                except (OSError, ValueError) as e:
                    # ValueError covers NULL-byte injection in the root spec;
                    # OSError covers transient resolution issues.
                    logger.warning(
                        f"destination_allowlist: failed to resolve root {r!r}: {e}"
                    )
                    continue
                # reject dangerous roots — fail-loud on operator misconfiguration.
                # an admin who types `C:\` (or accidentally sets the install dir
                # to a drive root) would otherwise authorize the agent (running
                # as SYSTEM) to write anywhere on that drive, including System32.
                if _is_dangerous_root(expanded):
                    logger.error(
                        f"destination_allowlist: REFUSING dangerous root {expanded!r} "
                        f"(drive root or system directory) — drop it from "
                        f"agent_config.allowed_extract_roots"
                    )
                    continue
                resolved.append(expanded)
            self._roots = resolved
        logger.info(
            f"destination_allowlist initialized with {len(self._roots)} root(s): "
            f"{[str(p) for p in self._roots]}"
        )

    @classmethod
    def from_config(cls, config: dict) -> 'DestinationAllowlist':
        """
        build from a config dict. expected shape:
            {'agent_config': {'allowed_extract_roots': ['/path/a', '/path/b']}}

        policy:
          - field missing entirely   → apply DEFAULT_ROOTS (the installer
            hasn't seeded a per-site override, so fall back to the
            documented default so roost works out of the box on v3.0+ agents).
          - field present but empty  → fail-closed. explicit opt-out by an
            admin who doesn't want the agent writing to disk.
          - field present with items → use those items verbatim.
        """
        agent_config = config.get('agent_config') or {}
        if 'allowed_extract_roots' not in agent_config:
            logger.info(
                f"destination_allowlist: 'allowed_extract_roots' not set in "
                f"config — applying DEFAULT_ROOTS {DEFAULT_ROOTS}"
            )
            return cls(DEFAULT_ROOTS)
        roots = agent_config.get('allowed_extract_roots')
        if not roots:
            logger.warning(
                "destination_allowlist: 'allowed_extract_roots' is empty — "
                "fail-closed (rejects all paths). remove the field or add an "
                "entry to allow extraction."
            )
        return cls(roots)

    def is_allowed(self, target: str) -> bool:
        """
        true if target path is under one of the allowed roots, with all
        path-traversal and symlink defenses applied. false otherwise.

        NEVER raises — for raising semantics use validate().
        """
        try:
            self.validate(target)
            return True
        except DestinationNotAllowedError:
            return False

    def validate(self, target: str) -> Path:
        """
        validate that target is under an allowed root. returns the resolved
        Path on success. raises DestinationNotAllowedError on rejection.

        the resolved path is what the caller should use for downstream file
        operations (defeats stale string-based paths).
        """
        if not self._roots:
            raise DestinationNotAllowedError(
                "destination allowlist is empty — refusing all writes. "
                "set agent_config.allowed_extract_roots to enable extraction."
            )

        if not target or not isinstance(target, str):
            raise DestinationNotAllowedError(
                f"invalid target path: {target!r}"
            )

        # normalize + expand user. ValueError catches NULL-byte injection
        # (`/path/file\x00.evil`) which os.path.expanduser raises on.
        try:
            expanded = Path(_safe_expanduser(target))
        except (ValueError, TypeError) as e:
            raise DestinationNotAllowedError(
                f"invalid characters in target path {target!r}: {e}"
            ) from e
        except Exception as e:
            raise DestinationNotAllowedError(
                f"could not expand path {target!r}: {e}"
            ) from e

        # reject relative paths outright — the caller must always pass an
        # absolute path. this prevents ambiguity from cwd-dependent resolution.
        if not expanded.is_absolute():
            raise DestinationNotAllowedError(
                f"target path must be absolute: {target!r}"
            )

        # reject windows alternate data streams + reserved device names.
        # ADS: `file.toe:hidden:$DATA` — colon syntax writes hidden bytes
        # into a stream attached to the parent. detection: any segment
        # containing `:` after the drive letter (`C:\\` is fine; `file:s` not).
        # device names: NUL/CON/PRN/AUX/COM1-9/LPT1-9 — Windows redirects
        # writes to the device regardless of extension (`NUL.txt` is NUL).
        if sys.platform == 'win32':
            for i, part in enumerate(expanded.parts):
                # part 0 on windows is `C:\\` — colon allowed there only.
                if i == 0:
                    continue
                if ':' in part:
                    raise DestinationNotAllowedError(
                        f"target path contains windows alternate data stream "
                        f"(`:` in segment {part!r}): {target!r}"
                    )
                # strip extensions and case-fold; reject NUL.txt, con.json, etc.
                stem = part.split('.')[0].casefold()
                if stem in _WINDOWS_RESERVED_NAMES:
                    raise DestinationNotAllowedError(
                        f"target path contains windows reserved device name "
                        f"(segment {part!r} resolves to device {stem.upper()}): {target!r}"
                    )

        # NOTE: resolve() follows symlinks AND junctions on windows — we
        # specifically want this so a symlink/junction pointing outside an
        # allowed root resolves to the real target and is detected by the
        # relative_to check below. strict=False because the file may not
        # exist yet (we're writing it).
        try:
            resolved = expanded.resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as e:
            raise DestinationNotAllowedError(
                f"could not resolve path {target!r}: {e}"
            ) from e

        # defense-in-depth: even after resolve(), if any '..' segment
        # survived (can happen with non-existent intermediate dirs on
        # some platforms), reject explicitly. relative_to() below would
        # also catch this, but the message is clearer here.
        if '..' in resolved.parts:
            raise DestinationNotAllowedError(
                f"path contains unresolved '..' segment: {str(resolved)!r}"
            )

        # on windows, additionally walk the resolved path's parents and
        # ensure none are reparse points (symlink or junction). resolve()
        # handles most cases but defense-in-depth for cve-class bugs:
        # cve-2022-21658, cve-2025-4330.
        if sys.platform == 'win32':
            self._check_no_reparse_points(resolved)

        # is the resolved path under any allowed root?
        # on windows, NTFS is case-insensitive — compare case-folded so
        # 'C:\\Users\\Foo' allowlist matches 'c:\\users\\foo\\file' target.
        case_fold = sys.platform == 'win32'
        resolved_cmp = _case_fold_path(resolved) if case_fold else resolved
        for root in self._roots:
            root_cmp = _case_fold_path(root) if case_fold else root
            try:
                resolved_cmp.relative_to(root_cmp)
                # return the original-case resolved path (callers want
                # canonical filesystem casing for downstream operations).
                return resolved
            except ValueError:
                continue

        raise DestinationNotAllowedError(
            f"path {str(resolved)!r} is not under any allowed root: "
            f"{[str(r) for r in self._roots]}"
        )

    def _check_no_reparse_points(self, resolved: Path) -> None:
        """
        windows-specific: walk resolved path's parents and ensure none are
        reparse points (symlink OR junction). uses FILE_ATTRIBUTE_REPARSE_POINT
        rather than is_symlink() because junctions (IO_REPARSE_TAG_MOUNT_POINT)
        are creatable by any user without SeCreateSymbolicLinkPrivilege —
        they're the more common attacker primitive.

        FAIL-CLOSED on stat error for parents that exist: if we can't tell
        whether a parent is a reparse point, we deny. (Only ENOENT —
        parent doesn't exist yet, which is fine because we're creating the
        file — is allowed through.)
        """
        # walk from the resolved path UP to the drive root. Path('C:\\').parent == Path('C:\\')
        # so we use a seen-set as the loop terminator instead of cur != cur.parent
        # to handle the drive-root case correctly.
        cur = resolved
        seen: set = set()
        while True:
            if cur in seen:
                break
            seen.add(cur)
            try:
                st = os.lstat(str(cur))
            except FileNotFoundError:
                # this segment doesn't exist yet — fine, we're creating it.
                pass
            except OSError as e:
                # any other stat failure on an existing-or-unknown path:
                # FAIL-CLOSED. previous code logged-and-allowed which contradicted
                # the module's fail-closed doctrine.
                raise DestinationNotAllowedError(
                    f"refusing path: cannot verify parent {str(cur)!r} is not a "
                    f"reparse point ({e.__class__.__name__}: {e})"
                ) from e
            else:
                attrs = getattr(st, 'st_file_attributes', 0)
                if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
                    raise DestinationNotAllowedError(
                        f"refusing path containing reparse point at {str(cur)!r} "
                        f"(symlink or junction)"
                    )
            parent = cur.parent
            if parent == cur:
                break
            cur = parent

    @property
    def roots(self) -> List[Path]:
        """read-only view of resolved allowed roots."""
        return list(self._roots)

    def __repr__(self) -> str:
        return f"DestinationAllowlist(roots={[str(r) for r in self._roots]})"


def _case_fold_path(p: Path) -> Path:
    """
    return a case-folded path for windows comparison. uses str.casefold()
    rather than .lower() to handle international characters correctly.
    """
    return Path(str(p).casefold())


def _is_dangerous_root(p: Path) -> bool:
    """
    true if `p` is a drive root, system directory, or otherwise unsafe to
    use as an allowed extract root. used at allowlist construction time
    to fail-loud on operator misconfiguration.

    rationale: the agent runs as SYSTEM. an allowlist root of `C:\\` would
    grant write access to System32 + Program Files + everything else.
    detection here is heuristic — comprehensive lockdown is via dedicated
    OS-level ACLs.
    """
    parts = p.parts
    # drive roots: `C:\\` has 1 part, `/` has 1 part on POSIX.
    if len(parts) <= 1:
        return True
    # known system directories on windows
    if sys.platform == 'win32':
        path_str = str(p).casefold()
        # SystemRoot is typically C:\\Windows. reject any allowlist entry that:
        #   - IS a system path
        #   - is an ANCESTOR of a system path (e.g. C:\\Users would catch C:\\Users\\Foo)
        #   - is a DESCENDANT of a system path (e.g. C:\\Windows\\System32) —
        #     this catches symlinks/junctions named innocently that resolve
        #     to system dirs, since `__init__` ran resolve() before this check
        system_root = (os.environ.get('SystemRoot') or 'C:\\Windows').casefold()
        program_files = (os.environ.get('ProgramFiles') or 'C:\\Program Files').casefold()
        program_files_x86 = (
            os.environ.get('ProgramFiles(x86)') or 'C:\\Program Files (x86)'
        ).casefold()
        for sys_path in (system_root, program_files, program_files_x86):
            if path_str == sys_path:
                return True
            try:
                # is `p` an ancestor of (or equal to) sys_path?
                Path(sys_path).relative_to(p)
                return True
            except ValueError:
                pass
            try:
                # is `p` a descendant of (or equal to) sys_path?
                # this catches symlinks/junctions resolving INTO system dirs.
                Path(path_str).relative_to(sys_path)
                return True
            except ValueError:
                pass
    # posix: reject obvious system roots
    else:
        dangerous = {'/', '/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc'}
        if str(p) in dangerous:
            return True
    return False
