#!/usr/bin/env python3
"""
Scene — episode 3, "install owlette & pair your first machine" (wizard half only).

Drives the Inno Setup WIZARD PAGES for beats b01 / b03 / b04 of
../../scripts/03-install-and-pair.md at a human pace, waits out the real install, then
clicks Finish.

  python scenes/install_and_pair.py [path-to-installer.exe]

WHAT THIS SCENE COVERS
  b01  a hold on the clean desktop before launch, so the cold open has picture
  b03  license -> destination -> ready to install
  b04  the progress screen (WebView2 runtime, PawnIO driver, service install) and
       the finish page

WHAT IT DELIBERATELY DOES NOT COVER — every later beat is a different surface:
  b05 / b06 (machine side) / b10 — the owlette desktop app's "join a site" dialog.
      Since 3.0.0 the wizard does NOT block on a pairing console: at ssPostInstall it
      hands pairing to `owlette-desktop.exe --pair` with ewNoWait and returns
      (agent/owlette_installer.iss:845), so the wizard reaches its finish page while the
      app's pairing dialog sits on screen. Film that dialog with the CDP desktop harness
      (web/e2e/desktop-screenshots/): deterministic phrase, fixture ProgramData, no real
      device code burned. Do NOT drive it with pywinauto — it is WebView2 content and
      UIA exposes Tailwind class names, not stable control names.
  b02 / b06 (browser side) / b07-b09 — owlette.app, so the Playwright video harness
      (web/e2e/videos/). No 03-*.video.ts scene exists there yet.
  The visible pairing CONSOLE that older versions of this scene told you to film now
  only appears on an /ADD= bulk install or a machine with no WebView2 runtime
  (owlette_installer.iss:859-867). On this episode's path you will never see it.

PRECONDITIONS — read before running:
  * ELEVATED SHELL, not optional. PrivilegesRequired=admin (iss:96) means a
    non-elevated launch makes setup relaunch itself elevated under a new pid, and a
    non-elevated pywinauto cannot send input to that higher-integrity window at all
    (UIPI), nor click the UAC secure desktop. Start from an already-elevated
    PowerShell. Consequence for the shoot: no UAC prompt appears in this take, so
    b03's double-click + "click yes" moment is a separate hand-performed take —
    or let b03's narration ride the wizard pages, which it does read over cleanly.
  * `Unblock-File <installer>.exe` first, or the mark-of-the-web SmartScreen sheet
    lands in front of the wizard (docs/internal/gui-automation-machine-setup.md, §5).
  * VM STATE DECIDES b04. The captions the script's b04 calls out only appear on a
    machine that is MISSING those components: "Installing the WebView2 runtime..."
    (iss:644), "Installing the PawnIO driver..." (iss:748), then "Installing Owlette
    service..." (iss:917). Shoot on a clean image WITH internet — the WebView2
    bootstrapper runs before the pairing handoff (iss:881 then :904), so the runtime is
    present again by the time the handoff checks for it and b05 still gets the app
    dialog rather than the console fallback.
  * This drives a REAL installer on THIS machine: it really installs the service and
    really opens the app. Run it on the disposable demo box.

ENV KNOBS
  DUMP=1             print the live control tree instead of driving (locators vary by
                     Inno build) and exit
  INSTALL_TIMEOUT=N  seconds to wait for the finish page (default 900)
  SKIP_FINISH=1      leave the wizard sitting on its finish page instead of closing it
"""

from __future__ import annotations

import os
import re
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
# This file lives at dev/video-tutorials/capture-native/scenes/, so the repo root is four
# parents up: [0] scenes, [1] capture-native, [2] video-tutorials, [3] dev, [4] root.
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_INSTALLER_DIR = REPO_ROOT / "agent" / "build" / "installer_output"

# AppName is still "Owlette" (iss:62), so the wizard caption is
# "Setup - Owlette version X.Y.Z".
WIZARD_TITLE_RE = ".*Owlette.*"

# Inno button captions differ by build/locale; try the variants in order.
NEXT_TITLES = ("Next", "&Next >", "Next >")
INSTALL_TITLES = ("Install", "&Install")
FINISH_TITLES = ("Finish", "&Finish")

# Dwell budgets derived from the RENDERED voiceover, not guessed:
#   ffprobe -v error -show_entries format=duration -of csv=p=0 \
#     ../voiceover/out/03-install-and-pair/ep03-bNN.mp3
# 2026-08-25 render: b01 13.79s, b03 14.76s, b04 25.47s. Each budget rounds up with
# ~0.5s of headroom so the MP3 always fits under the picture.
B01_DWELL = 14.5
# b03 is split across the three pages it plays over; the glide+click between them adds
# ~1s, so the picture comfortably clears the 14.76s of narration.
B03_LICENSE_DWELL = 6.0
B03_DESTINATION_DWELL = 5.0
B03_READY_DWELL = 4.5
B04_NARRATION_S = 26.0  # the progress screen has to last at least this long
FINISH_DWELL = 5.0

DEFAULT_INSTALL_TIMEOUT_S = 900.0
POLL_INTERVAL_S = 2.0
POLL_NOTE_EVERY_S = 30.0

_VERSION_RE = re.compile(r"Owlette-Installer-v(\d+)\.(\d+)\.(\d+)", re.IGNORECASE)


def _version_key(path: Path) -> tuple[int, int, int]:
    """Numeric version tuple, so v2.12.21 beats v2.9.0 (a plain sort does not)."""
    match = _VERSION_RE.search(path.name)
    if not match:
        return (-1, -1, -1)
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def find_installer(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    candidates = list(DEFAULT_INSTALLER_DIR.glob("Owlette-Installer-*.exe"))
    if not candidates:
        # Name the resolved directory AND whether it exists, so a wrong REPO_ROOT (a
        # moved file, a changed parents[] index) diagnoses itself instead of reading as
        # "you forgot to build".
        state = "exists but is empty" if DEFAULT_INSTALLER_DIR.is_dir() else "does not exist"
        print(
            f"no installer found — pass one as an argument.\n"
            f"  looked in: {DEFAULT_INSTALLER_DIR} ({state})"
        )
        sys.exit(1)
    # Highest version wins; mtime breaks ties and orders anything unparseable.
    return max(candidates, key=lambda p: (_version_key(p), p.stat().st_mtime))


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


def attach_wizard(app: Application) -> object:
    """Get the wizard window, re-attaching by title if setup relaunched itself."""
    try:
        wizard = app.window(title_re=WIZARD_TITLE_RE)
        wizard.wait("visible ready", timeout=30)
        return wizard
    except PywinautoTimeout:
        pass

    # PrivilegesRequired=admin: from a NON-elevated shell setup restarts itself elevated
    # under a new pid, so the pid-scoped lookup above finds nothing. Re-attach by title
    # so DUMP still works — but input to that window will be blocked by UIPI, which is
    # why the header says to start elevated.
    try:
        reattached = Application(backend="uia").connect(title_re=WIZARD_TITLE_RE, timeout=30)
        wizard = reattached.window(title_re=WIZARD_TITLE_RE)
        wizard.wait("visible ready", timeout=15)
        print(
            "  !! re-attached by title — this shell is probably NOT elevated, so clicks\n"
            "     will be silently dropped (UIPI). restart from an elevated shell."
        )
        return wizard
    except Exception:
        print(
            "could not find the installer window.\n"
            "  - is a UAC prompt still open? accept it, or run from an elevated shell.\n"
            "  - is SmartScreen holding the exe? Unblock-File it first.\n"
            "  - inspect the live tree with DUMP=1."
        )
        sys.exit(1)


def wait_for_finish_page(wizard: object, timeout_s: float) -> float | None:
    """Poll until the wizard's Finish button is live. Returns elapsed s, or None.

    The install phase is minutes on a clean box — ssPostInstall runs the WebView2
    bootstrapper (iss:881), the PawnIO driver install (iss:885), the pairing handoff
    (iss:904) and only then install.bat (iss:917) — so this is a poll, not a fixed dwell.
    """
    started = time.monotonic()
    next_note = POLL_NOTE_EVERY_S
    while True:
        for name in FINISH_TITLES:
            try:
                btn = wizard.child_window(title=name, control_type="Button")  # type: ignore[attr-defined]
                if btn.exists(timeout=0) and btn.is_enabled():
                    return time.monotonic() - started
            except Exception:
                continue

        try:
            if not wizard.exists(timeout=0):  # type: ignore[attr-defined]
                print("  !! the wizard window is gone — cancelled, or setup crashed.")
                return None
        except Exception:
            pass

        elapsed = time.monotonic() - started
        if elapsed >= timeout_s:
            print(
                f"  !! no finish page after {timeout_s:.0f}s. the wizard is probably behind a\n"
                "     modal: the 'Pairing was not completed' box (iss:934, console and /ADD=\n"
                "     paths only) or a driver/SmartScreen prompt. clear it by hand — the take\n"
                "     is still usable; this scene just stops driving."
            )
            return None
        if elapsed >= next_note:
            print(f"  ... still installing ({elapsed:.0f}s) — webview2 / pawnio / service")
            next_note += POLL_NOTE_EVERY_S
        time.sleep(POLL_INTERVAL_S)


def print_epilogue(installer: Path) -> None:
    """Where the remaining beats of scripts/03-install-and-pair.md get shot."""
    print(
        "\nwizard half done. the rest of episode 3 is filmed on other surfaces:\n"
        "  b02, b07, b08, b09  owlette.app — the playwright video harness\n"
        "                      (web/e2e/videos/). no 03-*.video.ts scene exists yet;\n"
        "                      write one before shooting these.\n"
        "  b05                 the pairing phrase, in the owlette app's 'join a site'\n"
        "                      dialog that the installer just opened. film it with the\n"
        "                      CDP desktop harness (web/e2e/desktop-screenshots/) for a\n"
        "                      fixed phrase and a retakeable shot — filming the live one\n"
        "                      burns a device code per take and shows the real hostname.\n"
        "  b06                 two surfaces: the dialog's 'open owlette.app/add' button\n"
        "                      (CDP) and the add page it opens (web). sign the demo\n"
        "                      machine's browser in first or /add bounces through\n"
        "                      /login and drops the ?code= pre-fill.\n"
        "  b10                 recovery: close the dialog, reopen 'join site' from the\n"
        "                      app's hamburger menu (CDP). cut it BETWEEN b08 and b09.\n"
        "\nno console window is part of any of this — the wizard hands pairing to\n"
        "owlette-desktop.exe --pair (iss:845). the console path is /ADD= or no-WebView2\n"
        "only.\n"
        f"\ninstaller used: {installer}\n"
        "the service is now installed and running on this box; re-image before the next take."
    )


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    installer = find_installer(sys.argv[1] if len(sys.argv) > 1 else None)
    dump_only = bool(os.environ.get("DUMP"))
    try:
        timeout_s = float(os.environ.get("INSTALL_TIMEOUT", DEFAULT_INSTALL_TIMEOUT_S))
    except ValueError:
        print("INSTALL_TIMEOUT must be a number of seconds.")
        sys.exit(1)

    print(f"launching installer: {installer}")

    # [b01] cold open — hold on the clean desktop before anything paints over it.
    # (The double-click itself is a hand take; this scene starts the exe directly.)
    if not dump_only:
        beat(B01_DWELL, "b01 clean desktop, installer sitting on it")

    app = Application(backend="uia").start(f'"{installer}"')
    time.sleep(2)  # let the wizard paint
    wizard = attach_wizard(app)

    if dump_only:
        dump_identifiers(wizard, depth=4)
        return

    # [b03] running the installer. DisableWelcomePage=yes (iss:108) + LicenseFile
    # (iss:90) + DisableProgramGroupPage=yes (iss:105) + AlwaysShowDirOnReadyPage=no
    # (iss:107) + an empty [Tasks] section (iss:116) leave exactly three pages before the
    # progress screen — which is why this is Next / Next / Install.
    beat(B03_LICENSE_DWELL, "b03 license page")
    click_button(wizard, *NEXT_TITLES)

    beat(B03_DESTINATION_DWELL, "b03 destination page")
    click_button(wizard, *NEXT_TITLES)

    beat(B03_READY_DWELL, "b03 ready to install")
    if not click_button(wizard, *INSTALL_TITLES):
        print("never reached the install page — nothing to wait for; stopping.")
        return

    # [b04] what it's installing — poll the real install instead of guessing a dwell.
    print(f"  [vo] b04 install progress (polling for the finish page, limit {timeout_s:.0f}s)")
    install_s = wait_for_finish_page(wizard, timeout_s)
    if install_s is None:
        print_epilogue(installer)
        return

    print(f"  [rec] install phase ran {install_s:.0f}s")
    if install_s < B04_NARRATION_S:
        print(
            f"  !! shorter than b04's narration ({B04_NARRATION_S:.0f}s). this machine\n"
            "     already had WebView2 + PawnIO, so the captions b04 talks about never\n"
            "     appeared. shoot on a clean image, or cut b04 to the shorter picture."
        )

    # The --pair app window opened over the wizard during ssPostInstall, so raise the
    # wizard before dwelling on (and clicking) its finish page.
    try:
        wizard.set_focus()  # type: ignore[attr-defined]
    except Exception:
        pass
    beat(FINISH_DWELL, "b04 finish page")

    if os.environ.get("SKIP_FINISH"):
        print("SKIP_FINISH set — leaving the wizard on its finish page.")
    else:
        # Finish only — there is no "open owlette" checkbox to un-tick: it is gated on
        # ShouldOfferOpenApp, which is False once the handoff opened the app (iss:411).
        click_button(wizard, *FINISH_TITLES)

    print_epilogue(installer)


if __name__ == "__main__":
    main()
