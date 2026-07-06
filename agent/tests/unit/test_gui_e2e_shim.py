"""Unit tests for the OWLETTE_E2E widget-introspection shim in owlette_gui.

The shim (owlette_gui.OwletteConfigApp._e2e_dump_widget_rects) publishes the
on-screen rectangles of the add-process controls to a side file so the
full-machine e2e harness (dev/active/full-machine-e2e, Wave 2) can drive the
CustomTkinter GUI — which is invisible to Windows UIAutomation — by coordinate.

These tests exercise the dump method directly against a duck-typed ``self`` so
no real Tk window (or display) is required. They assert three things that make
the shim safe to ship default-off:
  * it writes the expected rects + centres to the documented side file,
  * it is strictly read-only (never reads config or calls save_config),
  * unmapped / missing widgets are skipped rather than crashing the dump.
"""

import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# The GUI module pulls in CustomTkinter + a few third-party widget libs that are
# not present in a headless test env. Stub them (as the other agent unit tests
# do for win32) so importing owlette_gui only needs tkinter + shared_utils.
for _name in ("customtkinter", "CTkListbox", "custom_messagebox", "CTkToolTip"):
    _stub = MagicMock()
    _stub.__all__ = []  # make `from CTkListbox import *` a no-op
    sys.modules.setdefault(_name, _stub)

try:
    import owlette_gui  # noqa: E402  (import after the stubs above)
except Exception as exc:  # pragma: no cover - environment without tkinter/deps
    pytest.skip(f"owlette_gui not importable: {exc}", allow_module_level=True)


def _widget(x, y, w, h, *, exists=True, mapped=True):
    """A stand-in for a Tk widget exposing only the winfo_* getters the shim
    reads. Anything else raising would surface an unintended (non-read-only)
    access."""
    return SimpleNamespace(
        winfo_exists=lambda: 1 if exists else 0,
        winfo_ismapped=lambda: 1 if mapped else 0,
        winfo_rootx=lambda: x,
        winfo_rooty=lambda: y,
        winfo_width=lambda: w,
        winfo_height=lambda: h,
    )


def _fake_app(widgets):
    """Build a duck-typed OwletteConfigApp carrying only what the dump touches.

    A plain SimpleNamespace (not a MagicMock) is deliberate: if the method ever
    reaches for ``self.config`` or ``self.firebase_client`` this raises
    AttributeError and the test fails loudly, which is exactly the read-only
    guarantee we want to lock in.
    """
    master = SimpleNamespace(
        winfo_rootx=lambda: 100, winfo_rooty=lambda: 200,
        winfo_width=lambda: 800, winfo_height=lambda: 600,
        title=lambda: "Owlette",
        winfo_exists=lambda: 0,      # 0 => finally-block skips rescheduling after()
        after=lambda *a, **k: None,  # present but unused given winfo_exists()==0
    )
    app = SimpleNamespace(master=master, **widgets)
    return app


@pytest.fixture()
def programdata(tmp_path, monkeypatch):
    """Point shared_utils.get_data_path at a temp ProgramData so the dump writes
    under the test's tmp dir."""
    monkeypatch.setenv("PROGRAMDATA", str(tmp_path))
    return tmp_path


def _rects_path(programdata):
    return programdata / "Owlette" / "tmp" / "e2e_widget_rects.json"


def test_dump_writes_expected_rects_and_centres(programdata):
    app = _fake_app({
        "new_button": _widget(10, 20, 30, 30),
        "name_entry": _widget(50, 100, 200, 24),
    })

    owlette_gui.OwletteConfigApp._e2e_dump_widget_rects(app)

    out = _rects_path(programdata)
    assert out.exists(), "shim must publish the side file"
    data = json.loads(out.read_text(encoding="utf-8"))

    assert data["schema"] == 1
    assert data["window"] == {
        "x": 100, "y": 200, "width": 800, "height": 600, "title": "Owlette",
    }
    # name_entry centre = rootx + w//2, rooty + h//2
    assert data["rects"]["name_entry"] == {
        "x": 50, "y": 100, "width": 200, "height": 24, "cx": 150, "cy": 112,
    }
    assert data["rects"]["new_button"]["cx"] == 25  # 10 + 30//2
    assert isinstance(data["updated_at"], int)


def test_unmapped_and_missing_widgets_are_skipped(programdata):
    app = _fake_app({
        "name_entry": _widget(50, 100, 200, 24, mapped=False),  # not laid out yet
        "exe_path_entry": _widget(50, 130, 200, 24),            # visible
        # cwd_entry deliberately absent -> getattr(self, ...) is None -> skipped
    })

    owlette_gui.OwletteConfigApp._e2e_dump_widget_rects(app)

    data = json.loads(_rects_path(programdata).read_text(encoding="utf-8"))
    assert "name_entry" not in data["rects"]      # unmapped -> skipped
    assert "cwd_entry" not in data["rects"]        # missing -> skipped
    assert "exe_path_entry" in data["rects"]       # mapped -> published


def test_dump_is_read_only_no_config_access(programdata):
    # A widget whose winfo_* raises must not abort the whole dump, and the
    # method must never touch config/firebase (SimpleNamespace would AttributeError).
    boom = SimpleNamespace(
        winfo_exists=lambda: 1, winfo_ismapped=lambda: 1,
        winfo_rootx=lambda: (_ for _ in ()).throw(RuntimeError("boom")),
        winfo_rooty=lambda: 0, winfo_width=lambda: 0, winfo_height=lambda: 0,
    )
    app = _fake_app({"name_entry": _widget(1, 2, 3, 4), "new_button": boom})

    owlette_gui.OwletteConfigApp._e2e_dump_widget_rects(app)  # must not raise

    data = json.loads(_rects_path(programdata).read_text(encoding="utf-8"))
    assert "name_entry" in data["rects"]   # good widget still published
    assert "new_button" not in data["rects"]  # throwing widget skipped
    assert not hasattr(app, "config")      # never materialized config state
