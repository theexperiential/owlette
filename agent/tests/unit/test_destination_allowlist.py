"""
tests for destination_allowlist — security-floor enforcement for roost
extraction targets. fail-closed semantics are critical: empty/missing
allowlist must reject all writes.
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from destination_allowlist import (
    DEFAULT_ROOTS,
    DestinationAllowlist,
    DestinationNotAllowedError,
)


# ─── fail-closed semantics (critical security property) ─────────────────


def test_none_roots_rejects_all_paths():
    allowlist = DestinationAllowlist(None)
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.exe')
    assert not allowlist.is_allowed('/tmp/anything')
    assert not allowlist.is_allowed(str(Path.home()))


def test_empty_roots_rejects_all_paths():
    allowlist = DestinationAllowlist([])
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.exe')
    assert not allowlist.is_allowed('/tmp/anything')


def test_empty_roots_validate_raises_with_clear_message():
    allowlist = DestinationAllowlist([])
    with pytest.raises(DestinationNotAllowedError, match="empty"):
        allowlist.validate('/anything')


def test_from_config_with_missing_agent_config_applies_defaults(tmp_path, monkeypatch):
    """no agent_config key → field unset → apply DEFAULT_ROOTS."""
    # Point DEFAULT_ROOTS at tmp_path so the test doesn't depend on
    # whether ~/Documents/Owlette exists on the CI runner.
    import destination_allowlist as mod
    monkeypatch.setattr(mod, 'DEFAULT_ROOTS', [str(tmp_path)])
    allowlist = mod.DestinationAllowlist.from_config({})
    assert allowlist.is_allowed(str(tmp_path / 'x' / 'y.toe'))


def test_from_config_with_missing_allowed_extract_roots_applies_defaults(tmp_path, monkeypatch):
    """agent_config exists but no allowed_extract_roots → apply DEFAULT_ROOTS."""
    import destination_allowlist as mod
    monkeypatch.setattr(mod, 'DEFAULT_ROOTS', [str(tmp_path)])
    allowlist = mod.DestinationAllowlist.from_config({'agent_config': {}})
    assert allowlist.is_allowed(str(tmp_path / 'x' / 'y.toe'))


def test_from_config_with_explicit_empty_list_is_fail_closed():
    """explicit empty list → reject all (deliberate lockdown state)."""
    allowlist = DestinationAllowlist.from_config({
        'agent_config': {'allowed_extract_roots': []}
    })
    assert not allowlist.is_allowed('/tmp/test')


# ─── path under allowed root ────────────────────────────────────────────


def test_path_under_allowed_root_is_allowed(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = tmp_path / 'project' / 'file.toe'
    assert allowlist.is_allowed(str(target))


def test_path_at_allowed_root_itself_is_allowed(tmp_path):
    """the root itself counts as 'under the root' — relative_to(self) returns '.'."""
    allowlist = DestinationAllowlist([str(tmp_path)])
    assert allowlist.is_allowed(str(tmp_path))


def test_validate_returns_resolved_path(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = str(tmp_path / 'sub' / 'file.toe')
    result = allowlist.validate(target)
    assert isinstance(result, Path)
    assert result.is_absolute()


# ─── path traversal rejection ───────────────────────────────────────────


def test_path_traversal_with_dotdot_is_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    # traversal from inside the allowed root that escapes via ..
    target = str(tmp_path / 'sub' / '..' / '..' / 'evil.exe')
    assert not allowlist.is_allowed(target)


def test_sibling_dir_outside_allowlist_rejected(tmp_path):
    """allowed root is tmp_path/a; trying tmp_path/b should reject."""
    a = tmp_path / 'a'
    b = tmp_path / 'b'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a)])
    assert not allowlist.is_allowed(str(b / 'file'))


def test_completely_unrelated_root_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    if sys.platform == 'win32':
        target = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    else:
        target = '/etc/passwd'
    assert not allowlist.is_allowed(target)


# ─── invalid input rejection ────────────────────────────────────────────


def test_relative_path_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError, match="absolute"):
        allowlist.validate('relative/path/file')


def test_empty_target_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate('')


def test_none_target_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate(None)  # type: ignore[arg-type]


def test_null_byte_in_target_raises_DestinationNotAllowedError(tmp_path):
    """
    NULL byte injection: os.path.expanduser raises ValueError, which must
    be wrapped in DestinationNotAllowedError so callers' try/except works.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate(str(tmp_path / 'file\x00.evil'))
    # is_allowed wrapper must also return False, not bubble the ValueError
    assert not allowlist.is_allowed(str(tmp_path / 'evil\x00.toe'))


# ─── multiple roots ────────────────────────────────────────────────────


def test_multiple_roots_any_match_allows(tmp_path):
    a = tmp_path / 'a'
    b = tmp_path / 'b'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a), str(b)])
    assert allowlist.is_allowed(str(a / 'file'))
    assert allowlist.is_allowed(str(b / 'file'))
    assert not allowlist.is_allowed(str(tmp_path / 'c' / 'file'))


# ─── tilde expansion ───────────────────────────────────────────────────


def test_tilde_in_root_is_expanded():
    allowlist = DestinationAllowlist(['~/Documents/Owlette'])
    home = Path.home() / 'Documents' / 'Owlette'
    resolved_roots = allowlist.roots
    assert any(str(r) == str(home.resolve()) for r in resolved_roots), (
        f"expected ~/Documents/Owlette to expand to {home}, got {resolved_roots}"
    )


def test_tilde_in_target_is_expanded(tmp_path, monkeypatch):
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))  # windows
    allowed = tmp_path / 'Documents' / 'Owlette'
    allowed.mkdir(parents=True)
    allowlist = DestinationAllowlist([str(allowed)])
    assert allowlist.is_allowed('~/Documents/Owlette/file.toe')


# ─── invalid root entries (false-positive fix) ─────────────────────────


def test_invalid_root_entries_are_skipped_keeping_valid_one(tmp_path):
    """
    feedback fix: previously this asserted len==1 without verifying WHICH
    survived — could have been any path resolution side-effect.
    """
    valid_root = tmp_path / 'valid'
    valid_root.mkdir()
    allowlist = DestinationAllowlist([
        '',                  # empty string — skipped
        None,                # None — skipped
        123,                 # not a string — skipped
        str(valid_root),     # actually valid
    ])
    assert len(allowlist.roots) == 1
    # explicit check: the surviving root is the valid one we provided
    assert allowlist.roots[0] == valid_root.resolve()


# ─── config loader ─────────────────────────────────────────────────────


def test_from_config_with_valid_roots():
    config = {
        'agent_config': {
            'allowed_extract_roots': ['/tmp/projects', '/data/projects']
        }
    }
    allowlist = DestinationAllowlist.from_config(config)
    assert len(allowlist.roots) == 2


# ─── repr for diagnostics (false-positive fix) ─────────────────────────


def test_repr_includes_roots(tmp_path):
    """
    feedback fix: previously only checked the class name; didn't verify
    the roots actually appear in the repr (despite the test name).
    """
    a = tmp_path / 'first-root'
    b = tmp_path / 'second-root'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a), str(b)])
    repr_str = repr(allowlist)
    assert 'DestinationAllowlist' in repr_str
    # actually verify both roots appear in the repr
    assert 'first-root' in repr_str
    assert 'second-root' in repr_str


# ─── DEFAULT_ROOTS sanity check (false-positive fix) ──────────────────


def test_default_roots_constant_is_safe():
    """
    feedback fix: previous final assertion `root.startswith('~') or '/' in root or '\\' in root`
    was tautological for any non-empty string. now actually verifies safety.
    """
    assert DEFAULT_ROOTS, "DEFAULT_ROOTS must not be empty"
    for root in DEFAULT_ROOTS:
        # explicit anti-system-path checks
        assert 'System32' not in root
        assert 'Program Files' not in root
        assert 'Windows' not in root
        # must be in user space — accept tilde or absolute user-dir paths
        assert root.startswith('~') or 'Users' in root or 'home' in root, (
            f"DEFAULT_ROOTS entry {root!r} doesn't look like a user-space path"
        )


# ─── windows-only: junction + symlink defense via reparse-point check ──


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows-specific reparse-point check')
def test_windows_symlink_in_parent_is_rejected(tmp_path):
    """
    create a symlink inside the allowed root pointing OUT of it.
    paths via the symlink should be rejected — resolve() follows the link
    and the resolved path is outside the allowed root.
    """
    allowed = tmp_path / 'allowed'
    outside = tmp_path / 'outside'
    allowed.mkdir()
    outside.mkdir()
    (outside / 'evil.txt').write_text('hostile')

    link = allowed / 'sneaky'
    try:
        os.symlink(str(outside), str(link), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation requires admin or developer mode on windows")

    allowlist = DestinationAllowlist([str(allowed)])
    target_via_symlink = str(link / 'evil.txt')
    assert not allowlist.is_allowed(target_via_symlink)


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows reparse-point attribute check')
def test_windows_reparse_point_detected_via_mocked_attribute(tmp_path):
    """
    junctions don't require admin to create but are fiddly to set up in
    pytest. mock the os.lstat to simulate the FILE_ATTRIBUTE_REPARSE_POINT
    bit being set on a parent — covers both junction AND symlink rejection
    via the same code path.
    """
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    sub = allowed / 'sub'
    sub.mkdir()
    target = sub / 'file.toe'

    allowlist = DestinationAllowlist([str(allowed)])
    # without the mock, the path is allowed (no actual reparse points)
    assert allowlist.is_allowed(str(target))

    # patch os.lstat to claim the 'sub' parent has reparse-point attribute
    real_lstat = os.lstat

    def fake_lstat(path):
        s = real_lstat(path)
        if str(sub) in str(path):
            class _Stat:
                pass
            obj = _Stat()
            for attr in dir(s):
                if not attr.startswith('_'):
                    try:
                        setattr(obj, attr, getattr(s, attr))
                    except (AttributeError, TypeError):
                        pass
            obj.st_file_attributes = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
            return obj
        return s

    with patch('destination_allowlist.os.lstat', side_effect=fake_lstat):
        with pytest.raises(DestinationNotAllowedError, match="reparse point"):
            allowlist.validate(str(target))


# ─── windows-only: case-insensitive match ─────────────────────────────


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows NTFS is case-insensitive')
def test_windows_case_insensitive_allowlist_match(tmp_path):
    """
    NTFS is case-insensitive but Path.relative_to() is case-sensitive.
    a user's allowlist of `C:\\Users\\Foo` must match a target like
    `c:\\users\\foo\\file.toe` returned by some windows APIs that lowercase.
    without case-folding this fails as "not under any allowed root".
    """
    allowed = tmp_path / 'AllowedDir'
    allowed.mkdir()
    allowlist = DestinationAllowlist([str(allowed)])

    # construct a target that points into the allowed dir but with
    # different casing — on NTFS this resolves to the same place.
    target = str(allowed).lower() + os.sep + 'file.toe'
    assert allowlist.is_allowed(target), (
        f"case-folded match failed: target={target!r} not allowed under {allowed!r}"
    )


# ─── stat OSError → fail-closed (was: fail-open log-and-allow) ────────


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows alternate data streams')
def test_windows_alternate_data_stream_rejected(tmp_path):
    """
    `C:\\AllowedDir\\file.toe:hidden:$DATA` is a Windows ADS — colon
    syntax that writes hidden bytes into a stream attached to the parent
    file. relative_to() succeeds because the colon doesn't trigger
    path-traversal, but the agent (running as SYSTEM) would silently
    create a hidden malicious payload. round-2 catch.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = str(tmp_path / 'file.toe:hidden:$DATA')
    with pytest.raises(DestinationNotAllowedError, match="alternate data stream"):
        allowlist.validate(target)
    assert not allowlist.is_allowed(target)


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows drive-root + system-dir rejection')
def test_windows_drive_root_in_allowlist_is_rejected():
    """
    operator misconfiguration: an admin who types `C:\\` as an allowed root
    would otherwise authorize the agent (SYSTEM) to write anywhere on C:,
    including System32. fail-loud at allowlist construction.
    """
    allowlist = DestinationAllowlist(['C:\\'])
    # the dangerous root is dropped — allowlist becomes empty → fail-closed
    assert allowlist.roots == []
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.dll')


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows system-dir rejection')
def test_windows_system_root_in_allowlist_is_rejected():
    """
    `C:\\Windows` (or whatever %SystemRoot% resolves to) must be rejected
    as a dangerous allowlist root — same justification as drive-root.
    """
    import os
    system_root = os.environ.get('SystemRoot', 'C:\\Windows')
    allowlist = DestinationAllowlist([system_root])
    assert allowlist.roots == []


def test_posix_root_in_allowlist_is_rejected():
    """`/` as an allowed root authorizes everything on the system. reject."""
    if sys.platform == 'win32':
        pytest.skip('posix-only test')
    allowlist = DestinationAllowlist(['/'])
    assert allowlist.roots == []


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows reserved device names')
def test_windows_reserved_device_names_rejected(tmp_path):
    """
    Windows reserved device names (NUL, CON, PRN, AUX, COM1-9, LPT1-9)
    redirect i/o to the named device regardless of extension. an attacker
    manifest with `<allowed>/NUL` or `<allowed>/sub/CON.toe` would silently
    corrupt data or attach to console/printer streams. round-3 catch.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    for name in ('NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT9', 'NUL.txt', 'con.json', 'COM5.toe'):
        target = str(tmp_path / 'sub' / name)
        with pytest.raises(DestinationNotAllowedError, match="reserved device name"):
            allowlist.validate(target)
    # legitimate names with similar prefixes pass
    assert allowlist.is_allowed(str(tmp_path / 'console.toe'))   # not CON
    assert allowlist.is_allowed(str(tmp_path / 'auxiliary.toe')) # not AUX
    assert allowlist.is_allowed(str(tmp_path / 'communications.toe')) # not COM1


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows system-dir descendant check')
def test_windows_descendant_of_system_dir_rejected(tmp_path):
    """
    `_is_dangerous_root` previously only checked p-as-ancestor of system
    paths. a symlink at `D:\\my_safe_dir` pointing to `C:\\Windows\\System32`
    would resolve to a descendant of SystemRoot and bypass the check.
    round-3 catch.
    """
    import os
    system_root = os.environ.get('SystemRoot', 'C:\\Windows')
    # try a descendant
    descendant = system_root + '\\System32'
    allowlist = DestinationAllowlist([descendant])
    assert allowlist.roots == [], (
        f"expected descendant of SystemRoot to be rejected, got {allowlist.roots}"
    )


@pytest.mark.skipif(sys.platform != 'win32', reason='reparse-point check is windows-only')
def test_windows_stat_permission_error_fails_closed(tmp_path):
    """
    if we can't stat a parent path, FAIL-CLOSED. previous behavior was
    fail-open ("treat as safe-ish") which contradicted the fail-closed
    doctrine. only ENOENT (parent doesn't exist yet) is allowed through.
    """
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    target = allowed / 'file.toe'
    allowlist = DestinationAllowlist([str(allowed)])

    # without mock: passes
    assert allowlist.is_allowed(str(target))

    # with mock raising PermissionError on the parent: fail-closed
    real_lstat = os.lstat

    def fake_lstat(path):
        if str(path).startswith(str(allowed)):
            raise PermissionError(13, 'Access denied', str(path))
        return real_lstat(path)

    with patch('destination_allowlist.os.lstat', side_effect=fake_lstat):
        with pytest.raises(DestinationNotAllowedError, match="cannot verify"):
            allowlist.validate(str(target))
