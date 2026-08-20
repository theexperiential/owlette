"""Wave 1 - fresh-install smoke (no GUI).

Empty machine -> pre-authorize a phrase -> silent install with /ADD= ->
assert the compound pairing oracle -> assert service bootstrap + real dev
heartbeat -> silent uninstall -> assert documented clean-removal -> tear down
cloud state. This is the first *automated install test* of the shipped binary.

MUST run:
  - ELEVATED (installing a service needs admin),
  - in an interactive session (not Session 0),
  - on a THROWAWAY machine with NO Owlette installed (it refuses otherwise -
    a fresh install over a live agent would trigger the upgrade path).

Cloud work is delegated to the Node helpers in ../lib (firebase-admin); this
controller never imports firebase_admin. Node >= 20 must be on PATH.

Usage:
  python run_wave1.py --installer C:\\path\\to\\Owlette-Installer-vX.Y.Z.exe
  python run_wave1.py --installer <path> --negative   # prove exit-0 != paired
  python run_wave1.py --installer <path> --keep-cloud  # skip cloud teardown (debug)
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

# real agent paths (from agent/src + owlette_installer.iss)
INSTALL_DIR = Path(r"C:\ProgramData\Owlette")
SERVICE = "OwletteService"
STATUS_JSON = INSTALL_DIR / "tmp" / "service_status.json"
SERVICE_LOG = INSTALL_DIR / "logs" / "service.log"
CONFIG_JSON = INSTALL_DIR / "config" / "config.json"
TOKENS_CANDIDATES = [INSTALL_DIR / "config" / ".tokens.enc", INSTALL_DIR / ".tokens.enc"]
UNINSTALLER = INSTALL_DIR / "unins000.exe"
APPID_KEY = "{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}_is1"
UNINSTALL_KEYS = [
    rf"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{APPID_KEY}",
    rf"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{APPID_KEY}",
]
INSTALLED_MARKER_DIRS = [INSTALL_DIR / "python", INSTALL_DIR / "agent"]

SITE_ID = "e2e-fullmachine"  # must match e2e-machine/lib/admin.mjs
HEARTBEAT_BUDGET_SEC = 200    # adaptive 5-120s interval -> budget generously
REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "e2e-machine" / "lib"

results = []


def record(stage, ok, detail=""):
    results.append((stage, ok))
    print(f"{'PASS' if ok else 'FAIL'} | {stage}" + (f" | {detail}" if detail else ""), flush=True)
    return ok


def run(cmd, timeout=600):
    # explicit UTF-8: the locale codepage mojibakes Node/sc/reg output
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def node(script, *args, timeout=90):
    proc = run(["node", str(LIB / script), *[str(a) for a in args]], timeout=timeout)
    line = next((ln for ln in reversed(proc.stdout.splitlines()) if ln.strip()), "")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"unparseable node output (rc={proc.returncode}): {proc.stdout}{proc.stderr}"}


def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def process_session():
    sid = ctypes.c_ulong()
    ctypes.windll.kernel32.ProcessIdToSessionId(ctypes.windll.kernel32.GetCurrentProcessId(), ctypes.byref(sid))
    return sid.value


def service_state(name):
    """Return 'RUNNING' / 'STOPPED' / '<other>' / None (absent, sc 1060)."""
    proc = run(["sc", "query", name], timeout=30)
    if proc.returncode == 1060 or "1060" in proc.stdout:
        return None
    for line in proc.stdout.splitlines():
        if "STATE" in line:
            parts = line.split()
            return parts[-1]
    return "UNKNOWN"


def registry_key_exists(key):
    return run(["reg", "query", key], timeout=30).returncode == 0


def tokens_present():
    for p in TOKENS_CANDIDATES:
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


def config_bound_to_site():
    if not CONFIG_JSON.exists():
        return False
    try:
        data = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
        fb = data.get("firebase", {}) if isinstance(data, dict) else {}
        if fb.get("site_id") == SITE_ID or (fb.get("enabled") and SITE_ID in json.dumps(data)):
            return True
    except Exception:
        pass
    return SITE_ID in CONFIG_JSON.read_text(encoding="utf-8", errors="ignore")


def unblock(path):
    run(["powershell", "-NoProfile", "-Command", f"Unblock-File -Path '{path}'"], timeout=60)


# stages

def stage0_preflight():
    ok = True
    if not is_admin():
        return record("0 preflight: elevated", False, "not elevated - re-run from an elevated shell (install needs admin)")
    record("0 preflight: elevated", True)
    if process_session() == 0:
        return record("0 preflight: interactive session", False, "process is in Session 0 - run as the logged-on user, not a service")
    record("0 preflight: interactive session", True, f"session {process_session()}")

    svc = service_state(SERVICE)
    dir_present = INSTALL_DIR.exists()
    key_present = any(registry_key_exists(k) for k in UNINSTALL_KEYS)
    clean = svc is None and not dir_present and not key_present
    ok &= record("0 preflight: machine is empty", clean,
                 f"service={svc or 'absent'} dir={'present' if dir_present else 'absent'} uninstallKey={'present' if key_present else 'absent'}"
                 + ("" if clean else "  <- refusing: Wave 1 needs a machine with NO Owlette installed"))
    return ok


def stage1_preauth(negative):
    if negative:
        record("1 pre-auth: NEGATIVE mode", True, "using a deliberately-invalid phrase to prove exit-0 != paired")
        return {"phrase": "zzz-invalid-nonexistent-phrase", "negative": True}
    res = node("preauthorize.mjs")
    ok = record("1 pre-auth: phrase authorized (deferTokenMint)", bool(res.get("phrase")),
                res.get("phrase", res.get("error", "")))
    return res if ok else None


def stage2_install(installer, phrase, negative):
    installer = Path(installer)
    if not installer.exists():
        return record("2 install: installer present", False, f"not found: {installer}")
    unblock(installer)
    setup_log = Path(os.environ.get("TEMP", ".")) / "owlette-wave1-setup.log"
    cmd = [str(installer), "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES",
           "/SERVER=dev", f"/ADD={phrase}", f"/LOG={setup_log}"]
    proc = run(cmd, timeout=900)
    record("2 install: installer ran", True, f"exit={proc.returncode} (NOT trusted as a pairing oracle)")

    # Installer exit 0 is NOT proof of pairing: under /SUPPRESSMSGBOXES a pairing
    # failure is swallowed and the service skipped, still exiting 0
    # (owlette_installer.iss:341-357). Hence the compound oracle.
    svc = service_state(SERVICE)
    tok = tokens_present()
    bound = config_bound_to_site()
    log_txt = setup_log.read_text(encoding="utf-8", errors="ignore") if setup_log.exists() else ""
    pairing_logged = "Pairing exit code: 0" in log_txt

    checks = {
        "service RUNNING": svc == "RUNNING",
        ".tokens.enc present+nonempty": tok is not None,
        f"config bound to {SITE_ID}": bound,
        "setup log 'Pairing exit code: 0'": pairing_logged,
    }
    detail = ", ".join(f"{k}={'Y' if v else 'N'}" for k, v in checks.items())
    paired = all(checks.values())

    if negative:
        # negative mode: success means we correctly detected NO pairing
        return record("2 install: NEGATIVE - pairing correctly detected as FAILED", not paired,
                      detail + "  (expected all N)")
    return record("2 install: compound pairing oracle", paired, detail)


def stage3_bootstrap(hostname):
    ok = True
    # install.bat already ran `owlette-host start` — poll, don't `net start`
    deadline = time.time() + 60
    svc = service_state(SERVICE)
    while svc != "RUNNING" and time.time() < deadline:
        time.sleep(3)
        svc = service_state(SERVICE)
    ok &= record("3 bootstrap: service RUNNING", svc == "RUNNING", f"state={svc}")

    # service_status.json firebase.connected
    connected = False
    deadline = time.time() + 60
    while time.time() < deadline:
        if STATUS_JSON.exists():
            try:
                data = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
                connected = bool(data.get("firebase", {}).get("connected"))
                if connected:
                    break
            except Exception:
                pass
        time.sleep(3)
    ok &= record("3 bootstrap: service_status.json firebase.connected", connected,
                 f"path={STATUS_JSON}")

    # Must match an INFO-level marker: 'agent_started' is only logged at DEBUG and
    # is invisible at the default level. 'owlette initialized' fires on first_start
    # regardless of Firebase state.
    STARTUP_MARKERS = ("owlette initialized", "Firebase client initialized and started")
    if SERVICE_LOG.exists():
        log_txt = SERVICE_LOG.read_text(encoding="utf-8", errors="ignore")
        started = any(m in log_txt for m in STARTUP_MARKERS)
        clean = not any(lvl in log_txt for lvl in (" ERROR ", " CRITICAL "))
        ok &= record("3 bootstrap: service.log startup marker, no ERROR/CRITICAL", started and clean,
                     f"started={started} noErrors={clean}")
    else:
        ok &= record("3 bootstrap: service.log present", False, f"missing {SERVICE_LOG}")

    # Real dev Firestore heartbeat
    hb = False
    deadline = time.time() + HEARTBEAT_BUDGET_SEC
    last = {}
    while time.time() < deadline:
        last = node("probe.mjs", hostname)
        age = last.get("lastHeartbeatAgeSec")
        if last.get("machineExists") and age is not None and age < 180:
            hb = True
            break
        time.sleep(10)
    ok &= record("3 bootstrap: dev Firestore heartbeat < 180s", hb,
                 f"exists={last.get('machineExists')} ageSec={last.get('lastHeartbeatAgeSec')} version={last.get('agentVersion')}")
    return ok


def stage7_uninstall():
    if not UNINSTALLER.exists():
        return record("7 uninstall: uninstaller present", False, f"missing {UNINSTALLER}")
    run([str(UNINSTALLER), "/VERYSILENT", "/SUPPRESSMSGBOXES"], timeout=600)

    deadline = time.time() + 60
    while service_state(SERVICE) is not None and time.time() < deadline:
        time.sleep(3)
    ok = record("7 uninstall: service removed", service_state(SERVICE) is None)

    bins_gone = not any(d.exists() for d in INSTALLED_MARKER_DIRS)
    ok &= record("7 uninstall: program binaries removed", bins_gone,
                 ", ".join(f"{d.name}={'gone' if not d.exists() else 'PRESENT'}" for d in INSTALLED_MARKER_DIRS))
    key_gone = not any(registry_key_exists(k) for k in UNINSTALL_KEYS)
    ok &= record("7 uninstall: registry uninstall key removed", key_gone)
    # silent uninstall preserves user data by design (iss DeinitializeSetup)
    record("7 uninstall: user data preserved by design (informational)", True,
           f"tokens/config/logs left in {INSTALL_DIR} - snapshot revert is the true reset")
    return ok


def cloud_teardown(full=True):
    res = node("teardown.mjs", *(["--full"] if full else []))
    record("8 cloud teardown", res.get("ok", False), json.dumps(res.get("removed", res.get("error", ""))))


def main():
    ap = argparse.ArgumentParser(description="Wave 1 fresh-install smoke")
    ap.add_argument("--installer", required=True, help="path to Owlette-Installer-vX.Y.Z.exe")
    ap.add_argument("--negative", action="store_true", help="prove exit-0 != paired with an invalid phrase")
    ap.add_argument("--keep-cloud", action="store_true", help="skip cloud teardown (debug)")
    args = ap.parse_args()

    hostname = socket.gethostname()
    print(f"Wave 1 | host={hostname} | installer={args.installer} | negative={args.negative}\n", flush=True)

    installed = False
    try:
        if stage0_preflight():
            pre = stage1_preauth(args.negative)
            if pre is not None:
                installed = True  # installer copies files before the pairing step, even on failure
                paired_ok = stage2_install(args.installer, pre["phrase"], args.negative)
                if not args.negative:
                    if paired_ok:
                        stage3_bootstrap(hostname)
                    stage7_uninstall()
    except Exception as exc:  # noqa: BLE001
        record("CONTROLLER ERROR", False, repr(exc))
    finally:
        # leave the box clean; a successful stage 7 already removed the uninstaller
        if installed and UNINSTALLER.exists():
            run([str(UNINSTALLER), "/VERYSILENT", "/SUPPRESSMSGBOXES"], timeout=600)
        if not args.keep_cloud:
            cloud_teardown(full=True)

    passed = sum(1 for _, ok in results if ok)
    print(f"\nWAVE 1 RESULT: {passed}/{len(results)} stages passed", flush=True)
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
