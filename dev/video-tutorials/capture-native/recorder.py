#!/usr/bin/env python3
"""
recorder.py — native-capture utilities for the tutorial pipeline.

Playwright can't touch the installer wizard, the Tkinter agent GUI, or the tray icon —
those are native windows. pywinauto is the desktop equivalent: it drives Win32/WinForms/
WPF apps and moves the *real* mouse cursor, so the action reads on screen.

This module gives scenes (in scenes/) two things:
  1. human-paced driving helpers (visible cursor glide, per-key typing, dwell beats),
  2. an optional ffmpeg screen recorder — though for the installer flow OBS (started by
     hand) is usually simpler and higher quality. Either works; the driving is the same.

It is also handy for *tuning*: `dump_identifiers(window)` prints a control tree so you
can find the real button/edit names in the wizard or GUI, which vary by build.

Run elevated (Owlette installs a service → UAC). pywinauto cannot click the UAC secure-
desktop prompt; either launch from an already-elevated shell or accept UAC by hand.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

# pywinauto is only needed when a scene actually drives a window. Import lazily so this
# module can be imported (e.g. for --help) on a machine without it installed.
try:
    import pywinauto  # noqa: F401
    from pywinauto import mouse  # type: ignore
    from pywinauto.keyboard import send_keys  # type: ignore

    _HAVE_PYWINAUTO = True
except ImportError:  # pragma: no cover - guidance path
    _HAVE_PYWINAUTO = False


def _require_pywinauto() -> None:
    if not _HAVE_PYWINAUTO:
        raise RuntimeError(
            "pywinauto is required — run `pip install -r requirements.txt` "
            "(this is windows-only)."
        )


# --------------------------------------------------------------------------- #
#  Pacing                                                                     #
# --------------------------------------------------------------------------- #
def beat(seconds: float, label: str = "") -> None:
    """Dwell so the screen lingers long enough to lay this beat's narration under it."""
    if label:
        print(f"  [vo] {label} (~{seconds:g}s)")
    time.sleep(seconds)


def _cursor_pos() -> Tuple[int, int]:
    """Current mouse position via Win32 GetCursorPos. pywinauto.mouse has no getter,
    so without this the glide below would start at the target and teleport."""
    try:
        import ctypes
        from ctypes import wintypes

        pt = wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))  # type: ignore[attr-defined]
        return pt.x, pt.y
    except Exception:
        return 0, 0


def smooth_move(x: int, y: int, steps: int = 24, total_s: float = 0.35) -> None:
    """Glide the real cursor to (x, y) so movement reads on camera, not a teleport."""
    _require_pywinauto()
    sx, sy = _cursor_pos()
    for i in range(1, steps + 1):
        nx = int(sx + (x - sx) * i / steps)
        ny = int(sy + (y - sy) * i / steps)
        mouse.move(coords=(nx, ny))
        time.sleep(total_s / steps)


def move_click(control: object, *, button: str = "left", pause_s: float = 0.25) -> None:
    """Glide to a pywinauto control's center, pause, then click it (real input)."""
    _require_pywinauto()
    rect = control.rectangle()  # type: ignore[attr-defined]
    smooth_move(rect.mid_point().x, rect.mid_point().y)
    time.sleep(pause_s)
    control.click_input(button=button)  # type: ignore[attr-defined]


def slow_type(text: str, *, cps: float = 18.0) -> None:
    """Type into the focused control one key at a time so keystrokes read on screen."""
    _require_pywinauto()
    delay = 1.0 / cps
    for ch in text:
        # send_keys escapes pywinauto's special chars ({}()+^%~) so literal text types.
        send_keys(ch, with_spaces=True, pause=0)
        time.sleep(delay)


def dump_identifiers(window: object, depth: int = 3) -> None:
    """Print a window's control tree — use this to find real control names to drive."""
    _require_pywinauto()
    window.print_control_identifiers(depth=depth)  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
#  Optional ffmpeg screen recorder                                            #
# --------------------------------------------------------------------------- #
class ScreenRecorder:
    """Record the desktop via ffmpeg's gdigrab. Optional — OBS by hand is fine too.

    Usage:
        rec = ScreenRecorder(Path("out/02-install.mp4"))
        rec.start()
        ...drive the installer...
        rec.stop()
    """

    def __init__(self, out_path: Path, framerate: int = 30) -> None:
        self.out_path = out_path
        self.framerate = framerate
        self._proc: Optional[subprocess.Popen] = None

    @staticmethod
    def available() -> bool:
        return shutil.which("ffmpeg") is not None

    def start(self) -> None:
        if not self.available():
            raise RuntimeError(
                "ffmpeg not found on PATH. Either install ffmpeg, or just record the "
                "native flow with OBS by hand (recommended for the installer)."
            )
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self._proc = subprocess.Popen(
            [
                "ffmpeg", "-y",
                "-f", "gdigrab", "-framerate", str(self.framerate), "-i", "desktop",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                str(self.out_path),
            ],
            stdin=subprocess.PIPE,
        )
        print(f"  [rec] recording -> {self.out_path}")

    def stop(self) -> None:
        if self._proc is None:
            return
        # 'q' tells ffmpeg to finalize the file cleanly (vs. a hard terminate).
        try:
            if self._proc.stdin:
                self._proc.stdin.write(b"q")
                self._proc.stdin.flush()
            self._proc.wait(timeout=10)
        except Exception:
            self._proc.terminate()
        finally:
            self._proc = None
            print(f"  [rec] saved -> {self.out_path}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    print(__doc__)
    print(f"pywinauto available: {_HAVE_PYWINAUTO}")
    print(f"ffmpeg available:    {ScreenRecorder.available()}")
    sys.exit(0)
