#!/usr/bin/env python3
"""
Scene — episode 2, "install owlette & pair your first machine" (native half).

Drives the Inno Setup installer WIZARD PAGES (beats b03–b04 of
../../scripts/02-install-and-pair.md) at a human pace, then STOPS. It deliberately does
not click "Finish": at ssPostInstall the installer launches `configure_site.py` in a
visible console and waits for it (ewWaitUntilTerminated), so the wizard blocks there
until pairing completes — there is no Finish button to click yet. The pairing phrase
(b05), the `[y/N]` browser prompt + add-machine page (b06–b07), and the dashboard
(b08–b09) live in that console + the PRODUCTION site, so capture them live with OBS —
this scene does not (and cannot from the wizard) drive them.

  python scenes/install_and_pair.py [path-to-installer.exe]

IMPORTANT — read before running:
  * Run from an ELEVATED shell. Owlette installs a service → UAC. pywinauto cannot
    click the UAC secure-desktop prompt; elevating up front avoids it.
  * Inno Setup control names differ between builds. The button titles below ("Next",
    "Install", "Finish") are best-effort. If a step can't find its control, set
    DUMP=1 to print the live control tree and adjust the locators:
        set DUMP=1 && python scenes/install_and_pair.py
  * This drives a REAL installer on THIS machine. Run it on the disposable demo box.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

# Make recorder.py (one dir up) importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from recorder import beat, dump_identifiers, move_click  # noqa: E402

try:
    from pywinauto import Application  # type: ignore
    from pywinauto.timings import TimeoutError as PywinautoTimeout  # type: ignore
except ImportError:
    print("pywinauto is required — pip install -r requirements.txt (windows only).")
    sys.exit(1)

# Default to the build output path from CLAUDE.md; override via argv[1].
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_INSTALLER_DIR = REPO_ROOT / "agent" / "build" / "installer_output"


def find_installer(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    candidates = sorted(DEFAULT_INSTALLER_DIR.glob("Owlette-Installer-*.exe"))
    if not candidates:
        print(f"no installer found in {DEFAULT_INSTALLER_DIR} — pass one as an argument.")
        sys.exit(1)
    return candidates[-1]  # newest by name (version-sorted)


def click_button(window: object, *names: str) -> bool:
    """Glide-click the first matching button by best-match title. Returns success."""
    for name in names:
        try:
            btn = window.child_window(title=name, control_type="Button")  # type: ignore[attr-defined]
            if btn.exists(timeout=1):
                move_click(btn)
                return True
        except Exception:
            continue
    print(f"  !! could not find any of buttons: {names} (set DUMP=1 to inspect)")
    return False


def main() -> None:
    installer = find_installer(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"launching installer: {installer}")

    app = Application(backend="uia").start(f'"{installer}"')
    time.sleep(2)  # let the wizard paint (and accept UAC by hand if it appears)

    try:
        wizard = app.window(title_re=".*Owlette.*")
        wizard.wait("visible ready", timeout=30)
    except PywinautoTimeout:
        print("could not find the installer window — is UAC still open? inspect with DUMP=1.")
        sys.exit(1)

    if os.environ.get("DUMP"):
        dump_identifiers(wizard, depth=4)
        return  # inspection only

    # [b03] running the installer — page through the wizard.
    beat(3, "b03 running the installer")
    click_button(wizard, "Next", "&Next >", "Next >")

    # If there's a license / destination page, advance again. Harmless if absent.
    beat(2.5, "b03 license / destination")
    click_button(wizard, "Next", "&Next >", "Next >")

    # [b04] what it's installing — kick off the install and let progress run.
    beat(2.5, "b04 begin install")
    click_button(wizard, "Install", "&Install")
    beat(8, "b04 install progress")  # let the progress bar advance on camera

    # STOP here — do NOT click Finish. At ssPostInstall the installer launches
    # configure_site.py in a visible console and waits for it, so the wizard blocks
    # until pairing finishes. The phrase + [y/N] browser prompt live in THAT console,
    # not on the wizard's finish page — capture them live with OBS.
    print(
        "\nwizard pages done — the installer is now running the pairing console.\n"
        "the wizard blocks here until pairing finishes; capture the rest live with OBS:\n"
        "  b05 - the 3-word pairing phrase prints in the configure_site console window\n"
        "  b06 - it prompts 'open browser on this machine? [y/N]' -> press y (or open\n"
        "        owlette.app/add on another device and type the phrase in yourself)\n"
        "  b07 - on owlette.app/add: pick a site, click authorize\n"
        "  b08-b09 - cut to the dashboard; the machine appears within ~30s\n"
        "once authorized, the console exits and the installer shows its finish page."
    )


if __name__ == "__main__":
    main()
