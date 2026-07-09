"""Wave 2 - GUI add-process smoke.

Drives the REAL Owlette CustomTkinter GUI (running with OWLETTE_E2E=1 so its
read-only introspection shim publishes widget rects) to add one monitored
process, then asserts the config round-trips to dev Firestore.

Stages:
  0 preflight   - interactive session (not Session 0) + pywinauto importable.
  1 gate        - GUI present with a FRESH shim side file (skip-vs-fail: if the
                  GUI isn't running under OWLETTE_E2E=1 this SKIPs, not fails).
  2 baseline    - read the machine's current synced process list (probe --config).
  3 drive       - "+" -> fill name + exe via the shim rects (pywinauto).
  4 oracle      - poll `node probe.mjs <host> --config` until the new process
                  name appears under config/e2e-fullmachine/machines/<host>.
  (+ best-effort screenshot artifact.)

Prereqs (see e2e-machine/RUNBOOK.md Part C + scripts/bootstrap-gui-automation.ps1):
  - the pinned pywinauto venv (run this script with that venv's python),
  - the box paired to the e2e-fullmachine site (probe.mjs is scoped to it),
  - the GUI launched with OWLETTE_E2E=1.

This drives real input on THIS machine. It adds a throwaway process to the e2e
site; teardown (e2e-machine/lib/teardown.mjs) removes it from the cloud.

Usage:
  python run_wave2.py                       # process name auto-derived
  python run_wave2.py --name e2e-td-probe   # explicit throwaway name
"""
import argparse
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "e2e-machine" / "lib"
sys.path.insert(0, str(Path(__file__).resolve().parent))  # for gui_driver

SITE_ID = "e2e-fullmachine"  # must match e2e-machine/lib/admin.mjs
RECTS_PATH = Path(r"C:\ProgramData\Owlette\tmp\e2e_widget_rects.json")
# The detail-form fields are unmapped until a process is selected (collapsed
# empty state), so the gate only requires controls that are ALWAYS present; the
# driver waits for the form fields itself after expanding the panel.
GATE_WIDGETS = ("new_button", "process_list")
TEST_EXE = r"C:\Windows\System32\notepad.exe"  # exists on every Windows box
ORACLE_BUDGET_SEC = 90
GATE_FRESH_S = 10.0

results = []
skipped = False


def record(stage, ok, detail=""):
    results.append((stage, ok))
    print(f"{'PASS' if ok else 'FAIL'} | {stage}" + (f" | {detail}" if detail else ""), flush=True)
    return ok


def skip(stage, detail=""):
    global skipped
    skipped = True
    print(f"SKIP | {stage}" + (f" | {detail}" if detail else ""), flush=True)


def run(cmd, timeout=120):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def node(script, *args, timeout=90):
    proc = run(["node", str(LIB / script), *[str(a) for a in args]], timeout=timeout)
    line = next((ln for ln in reversed(proc.stdout.splitlines()) if ln.strip()), "")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"unparseable node output (rc={proc.returncode}): {proc.stdout}{proc.stderr}"}


def process_session():
    sid = ctypes.c_ulong()
    ctypes.windll.kernel32.ProcessIdToSessionId(ctypes.windll.kernel32.GetCurrentProcessId(), ctypes.byref(sid))
    return sid.value


def shim_freshness():
    """Return (age_seconds, payload) for the shim side file, or (None, None)."""
    try:
        payload = json.loads(RECTS_PATH.read_text(encoding="utf-8"))
        return time.time() - payload.get("updated_at", 0), payload
    except Exception:
        return None, None


# --- stages ------------------------------------------------------------------

def stage0_preflight():
    ok = True
    sess = process_session()
    ok &= record("0 preflight: interactive session (not Session 0)", sess != 0, f"session {sess}")
    try:
        import gui_driver  # noqa: F401  (imports pywinauto + recorder)
        record("0 preflight: pywinauto driver importable", True)
    except Exception as exc:  # noqa: BLE001
        ok &= record("0 preflight: pywinauto driver importable", False,
                     f"{exc} - run under the pinned pywinauto venv")
    return ok


def stage1_gate():
    """Skip-vs-fail: a fresh shim file proves the GUI is up under OWLETTE_E2E=1."""
    age, payload = shim_freshness()
    if age is None:
        skip("1 gate: GUI + shim present", f"no shim file at {RECTS_PATH} - launch owlette_gui.py with OWLETTE_E2E=1")
        return None
    if age > GATE_FRESH_S:
        skip("1 gate: GUI + shim present", f"shim file stale ({age:.0f}s) - is the GUI still running under OWLETTE_E2E=1?")
        return None
    missing = [w for w in GATE_WIDGETS if w not in payload.get("rects", {})]
    if missing:
        skip("1 gate: GUI + shim present", f"widgets not published: {missing}")
        return None
    record("1 gate: GUI + shim present", True, f"pid={payload.get('pid')} age={age:.1f}s")
    return payload


def stage2_baseline(host):
    res = node("probe.mjs", host, "--config")
    before = set(res.get("processNames", []) or [])
    record("2 baseline: read synced config", res.get("ok", False),
           f"configExists={res.get('configExists')} processCount={res.get('processCount')} before={sorted(before)}")
    return before


def stage3_drive(name):
    import gui_driver
    try:
        gui_driver.add_monitored_process(name, TEST_EXE)
        return record("3 drive: add-process flow executed", True, f"name={name!r} exe={TEST_EXE}")
    except Exception as exc:  # noqa: BLE001
        return record("3 drive: add-process flow executed", False, repr(exc))


def stage4_oracle(host, name, before):
    seen = False
    deadline = time.time() + ORACLE_BUDGET_SEC
    last = {}
    while time.time() < deadline:
        last = node("probe.mjs", host, "--config")
        names = set(last.get("processNames", []) or [])
        if name in names and name not in before:
            seen = True
            break
        time.sleep(5)
    return record("4 oracle: process round-trips to dev Firestore", seen,
                  f"processNames={sorted(last.get('processNames', []) or [])} target={name!r}")


def screenshot_artifact():
    """Best-effort window capture. Silent no-op if Pillow isn't in the venv."""
    try:
        import gui_driver
        win = gui_driver.raise_window()
        if win is None:
            return
        out = Path(__file__).resolve().parent / ".artifacts"
        out.mkdir(exist_ok=True)
        img = win.capture_as_image()  # requires Pillow
        path = out / f"wave2-{int(time.time())}.png"
        img.save(str(path))
        record("+ artifact: window screenshot", True, str(path))
    except Exception as exc:  # noqa: BLE001
        print(f"INFO | screenshot skipped: {exc}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Wave 2 GUI add-process smoke")
    ap.add_argument("--name", default=None, help="throwaway process name (default: e2e-w2-<pid>)")
    args = ap.parse_args()

    host = socket.gethostname()
    name = args.name or f"e2e-w2-{os.getpid()}"
    print(f"Wave 2 | host={host} | process={name!r}\n", flush=True)

    if stage0_preflight():
        if stage1_gate() is not None:
            before = stage2_baseline(host)
            if stage3_drive(name):
                stage4_oracle(host, name, before)
            screenshot_artifact()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    if skipped and total == passed:
        print(f"\nWAVE 2 RESULT: SKIPPED (gate not met) - {passed}/{total} pre-gate checks passed", flush=True)
        sys.exit(2)
    print(f"\nWAVE 2 RESULT: {passed}/{total} stages passed", flush=True)
    sys.exit(0 if passed == total and total > 0 else 1)


if __name__ == "__main__":
    main()
