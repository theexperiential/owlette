"""Wave 2 GUI driver — drive the Owlette CustomTkinter GUI by coordinate.

CustomTkinter draws on a tk canvas, so UIAutomation sees the top-level window
but none of the controls inside. The GUI's OWLETTE_E2E shim publishes each
control's screen rectangle to a side file; this reads it and drives real
mouse/keyboard input through pywinauto.

Reuses smooth_move / slow_type from the tutorial capture harness
(dev/video-tutorials/capture-native/recorder.py).

Needs the pinned venv from scripts/bootstrap-gui-automation.ps1
(pywinauto 0.6.9 / pywin32 306 / psutil).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

# On the path so `import recorder` resolves regardless of CWD.
_REPO = Path(__file__).resolve().parents[2]
_CAPTURE_NATIVE = _REPO / "dev" / "video-tutorials" / "capture-native"
import sys
if str(_CAPTURE_NATIVE) not in sys.path:
    sys.path.insert(0, str(_CAPTURE_NATIVE))

import recorder  # noqa: E402  (smooth_move, slow_type, beat)
from pywinauto import Application  # noqa: E402
from pywinauto import mouse  # noqa: E402
from pywinauto.keyboard import send_keys  # noqa: E402

# The shim writes here (agent shared_utils.get_data_path('tmp/e2e_widget_rects.json')).
RECTS_PATH = Path(r"C:\ProgramData\Owlette\tmp\e2e_widget_rects.json")
WINDOW_TITLE_RE = ".*[Oo]wlette.*"


class ShimError(RuntimeError):
    """The introspection side file is missing, stale, or lacks a widget."""


def read_rects(required=(), fresh_within_s=10.0, timeout=20.0, poll=0.5):
    """Read the shim side file once it is fresh and exposes every widget in
    `required`; returns the {widget_name: rect} map.

    Raises ShimError on timeout — missing/stale means the GUI is not running
    with OWLETTE_E2E=1, or has not laid its widgets out yet.
    """
    deadline = time.time() + timeout
    last_reason = "no side file"
    while time.time() < deadline:
        try:
            payload = json.loads(RECTS_PATH.read_text(encoding="utf-8"))
            age = time.time() - payload.get("updated_at", 0)
            rects = payload.get("rects", {})
            missing = [w for w in required if w not in rects]
            if age > fresh_within_s:
                last_reason = f"side file stale ({age:.0f}s old)"
            elif missing:
                last_reason = f"widgets not yet published: {missing}"
            else:
                return rects
        except FileNotFoundError:
            last_reason = f"side file absent at {RECTS_PATH}"
        except (json.JSONDecodeError, ValueError):
            last_reason = "side file mid-write"  # atomic replace makes this rare
        time.sleep(poll)
    raise ShimError(f"widget rects unavailable after {timeout:.0f}s: {last_reason}")


def raise_window(timeout=10.0):
    """Bring the GUI window to the foreground so coordinate clicks land on it.
    Returns the pywinauto WindowSpecification (or None if it can't be focused)."""
    try:
        app = Application(backend="uia").connect(title_re=WINDOW_TITLE_RE, timeout=timeout)
        win = app.window(title_re=WINDOW_TITLE_RE)
        win.set_focus()
        time.sleep(0.3)
        return win
    except Exception:
        # Coordinate input still works if the window is already frontmost; the
        # caller decides whether a missing handle is fatal.
        return None


def _center(rects, name):
    r = rects[name]
    return r["cx"], r["cy"]


def click_widget(rects, name, *, pause_s=0.2):
    """Glide the real cursor to a widget's centre and click it."""
    cx, cy = _center(rects, name)
    recorder.smooth_move(cx, cy)
    time.sleep(pause_s)
    mouse.click(coords=(cx, cy))
    time.sleep(pause_s)


def click_row(rects, name, *, row_offset_px=18, pause_s=0.2):
    """Click near the TOP of a list widget to hit its first row (the widget
    centre can land in empty space below a single row)."""
    r = rects[name]
    cx, y = r["cx"], r["y"] + row_offset_px
    recorder.smooth_move(cx, y)
    time.sleep(pause_s)
    mouse.click(coords=(cx, y))
    time.sleep(pause_s)


def set_field(rects, name, text, *, commit=True):
    """Click into an entry, select-all, replace with `text`, and (by default)
    commit with Return so the GUI's FocusOut/Return soft-save fires."""
    click_widget(rects, name)
    send_keys("^a{DELETE}")  # clear whatever default text is there
    time.sleep(0.1)
    recorder.slow_type(text)
    if commit:
        send_keys("{ENTER}")
    time.sleep(0.2)


def add_monitored_process(process_name, exe_path):
    """Drive the full add-process flow and return the entered name.

    Order is forced: "+" -> toggle -> click row -> fill. The GUI persists a
    COLLAPSED detail panel, _show_detail_fields is a no-op while collapsed, and
    _expand_right_panel only maps the fields once a row is selected.
    """
    r = read_rects(required=("new_button", "process_list", "details_toggle_button"))
    raise_window()

    # 1) "+" creates + activates the row (kicks a background Firestore upload).
    click_widget(r, "new_button")
    recorder.beat(0.8, "row created")

    # 2) Expand unless already expanded — published form fields are the tell;
    #    toggling a shown panel would close it.
    r = read_rects(required=("details_toggle_button", "process_list"))
    if "name_entry" not in r:
        click_widget(r, "details_toggle_button")
        recorder.beat(0.8, "detail panel expanded")

    # 3) Select the row so on_select binds the form; with the panel expanded,
    #    _show_detail_fields(True) maps the fields.
    r = read_rects(required=("process_list",))
    click_row(r, "process_list")
    recorder.beat(0.8, "row selected -> fields shown")

    # 4) Wait for the shim to publish the mapped fields, then fill.
    r = read_rects(required=("name_entry", "exe_path_entry"), timeout=15)
    set_field(r, "name_entry", process_name)
    r = read_rects(required=("name_entry", "exe_path_entry"))
    set_field(r, "exe_path_entry", exe_path)
    return process_name
