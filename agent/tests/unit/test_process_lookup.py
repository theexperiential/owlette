"""
tests for shared_utils process lookup — the strict matching semantics that
back the kill/restart fallbacks (dashboard, Cortex, and GUI). Strict mode
must never match on a bare image name, must refuse ambiguous matches when
no file_path corroboration exists, and must find .bat/.cmd targets via
their cmd.exe wrapper.
"""

import psutil
import pytest

import shared_utils


class FakeProc:
    def __init__(self, pid, exe, cmdline=None):
        self.info = {'pid': pid, 'exe': exe}
        self._cmdline = cmdline if cmdline is not None else ([exe] if exe else [])

    def cmdline(self):
        return self._cmdline


def _patch_procs(monkeypatch, procs):
    monkeypatch.setattr(shared_utils.psutil, 'process_iter', lambda attrs=None: iter(procs))


TD_EXE = r'C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe'
TOE = r'C:\Shows\wall.toe'


# --- find_running_process_by_exe ---------------------------------------------

def test_strict_exact_path_unique_match(monkeypatch):
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) == 100


def test_strict_refuses_ambiguous_match_without_file_path(monkeypatch):
    _patch_procs(monkeypatch, [FakeProc(100, TD_EXE), FakeProc(200, TD_EXE)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) is None


def test_strict_never_matches_bare_basename(monkeypatch):
    other_dir = r'D:\other\TouchDesigner.exe'
    _patch_procs(monkeypatch, [FakeProc(100, other_dir)])
    assert shared_utils.find_running_process_by_exe(TD_EXE, strict=True) is None


def test_strict_file_path_corroboration_disambiguates(monkeypatch):
    _patch_procs(monkeypatch, [
        FakeProc(100, TD_EXE, [TD_EXE, r'C:\Shows\other.toe']),
        FakeProc(200, TD_EXE, [TD_EXE, TOE]),
    ])
    assert shared_utils.find_running_process_by_exe(TD_EXE, TOE, strict=True) == 200


def test_script_target_matches_cmd_wrapper_by_cmdline(monkeypatch):
    bat = r'C:\Program Files\Signage\start loop.bat'
    _patch_procs(monkeypatch, [
        FakeProc(100, r'C:\Windows\System32\cmd.exe', ['cmd.exe', '/s', '/c', 'something else']),
        FakeProc(200, r'C:\Windows\System32\cmd.exe', ['cmd.exe', '/s', '/c', f'"{bat}"']),
    ])
    assert shared_utils.find_running_process_by_exe(bat, strict=True) == 200


def test_non_strict_keeps_first_basename_match_for_adoption(monkeypatch):
    other_dir = r'D:\other\TouchDesigner.exe'
    _patch_procs(monkeypatch, [FakeProc(100, other_dir)])
    assert shared_utils.find_running_process_by_exe(TD_EXE) == 100


# --- pid_matches_exe ----------------------------------------------------------

def _patch_process(monkeypatch, table):
    class FakeProcess:
        def __init__(self, pid):
            if pid not in table:
                raise psutil.NoSuchProcess(pid)
            self._exe, self._cmdline = table[pid]

        def exe(self):
            return self._exe

        def cmdline(self):
            return self._cmdline

    monkeypatch.setattr(shared_utils.psutil, 'Process', FakeProcess)


def test_pid_matches_exact_exe(monkeypatch):
    _patch_process(monkeypatch, {100: (TD_EXE, [TD_EXE, TOE])})
    assert shared_utils.pid_matches_exe(100, TD_EXE) is True


def test_pid_rejects_recycled_pid_with_different_exe(monkeypatch):
    _patch_process(monkeypatch, {100: (r'C:\Windows\notepad.exe', [])})
    assert shared_utils.pid_matches_exe(100, TD_EXE) is False


def test_pid_requires_file_path_in_cmdline_when_provided(monkeypatch):
    _patch_process(monkeypatch, {100: (TD_EXE, [TD_EXE, r'C:\Shows\other.toe'])})
    assert shared_utils.pid_matches_exe(100, TD_EXE, TOE) is False


def test_pid_matches_bat_via_cmd_wrapper(monkeypatch):
    bat = r'C:\ops\run.bat'
    _patch_process(monkeypatch, {100: (r'C:\Windows\System32\cmd.exe', ['cmd.exe', '/s', '/c', f'"{bat}"'])})
    assert shared_utils.pid_matches_exe(100, bat) is True


def test_pid_dead_returns_false(monkeypatch):
    _patch_process(monkeypatch, {})
    assert shared_utils.pid_matches_exe(999999, TD_EXE) is False
