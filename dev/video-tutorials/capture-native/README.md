# Native capture (installer wizard + tray icon)

The two surfaces that are genuinely native windows, so neither Playwright nor CDP can
reach them. **pywinauto** drives them — the desktop equivalent of Playwright, and the
maintained 2026 choice (WinAppDriver is paused, FlaUI is .NET-only).

Windows-only. Run on the disposable demo machine.

## What is captured where

Owlette has three capture surfaces and only one of them belongs to this directory.

| Surface | Tool | Where |
|---|---|---|
| **Installer wizard** (Inno Setup, a Delphi `TWizardForm`) | pywinauto / UIA | **here** — `scenes/install_and_pair.py` |
| **Desktop app window**, including the "join a site" pairing dialog | WebView2 **CDP** | `web/e2e/desktop-screenshots/` (`npm run screenshots:desktop`) — its video sibling is the harness to extend, not this one |
| **Tray icon + its right-click menu** | UIA + `PrintWindow` | `web/e2e/desktop-screenshots/capture-tray-menu.ps1` |

**Do not point pywinauto at the desktop app's window.** It is WebView2 content: the UIA
tree exposes Tailwind class names, not stable control names. Drive it over CDP instead —
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` plus
`chromium.connectOverCDP` already works against the *installed* exe
(`web/e2e/desktop-screenshots/harness.ts:340`), with ProgramData and COMPUTERNAME
redirected to fixture trees, `layout.json` pinned, the live tray killed by PID, and a
`configure_site.py` stub that yields a deterministic pairing phrase without burning a
real device code. tauri-driver is not an option either: `tauri-plugin-single-instance`
forwards a second instance's argv to the first and exits, so a driver-spawned instance
never owns a window.

There is no python agent GUI or python tray to drive. Both were deleted in 3.0.0 (see
`agent/requirements.txt` — customtkinter, CTkListbox and pystray went with them); the
local UI is the Tauri app in `desktop/`.

## Setup

**Machine-level prep first** — display/DPI pinning, lock/sleep/power, RDP discipline, UAC,
mark-of-the-web, and the `pywin32==306` pin (why it must never be upgraded) are documented
once in
[docs/internal/gui-automation-machine-setup.md](../../../docs/internal/gui-automation-machine-setup.md)
(Profiles A + B), with `scripts/bootstrap-gui-automation.ps1 -Rig CaptureRig` as the
executable check. That doc is canonical for machine prep; this README only covers the
capture workflow itself.

```powershell
cd dev\video-tutorials\capture-native
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

## Record the installer wizard (episode 3, beats b01 / b03 / b04)

pywinauto *drives* the wizard (moves the real cursor, clicks, dwells). You *capture* with
OBS — recommended, and what the script's `surface: native (obs)` lines assume — or with
the optional `ScreenRecorder` (ffmpeg gdigrab) in `recorder.py`.

```powershell
# from an ALREADY-ELEVATED powershell:
Unblock-File C:\path\to\Owlette-Installer-v3.2.0.exe   # clears mark-of-the-web
# start OBS recording, then:
python scenes\install_and_pair.py                       # newest agent\build\installer_output\*.exe
python scenes\install_and_pair.py C:\path\to\Owlette-Installer-v3.2.0.exe
# stop OBS
```

Env knobs: `DUMP=1` (print the control tree and exit), `INSTALL_TIMEOUT=<seconds>`
(finish-page poll limit, default 900), `SKIP_FINISH=1` (leave the wizard on its finish
page instead of closing it).

### Elevation is mandatory, and it costs you the UAC shot

`PrivilegesRequired=admin`, so from a non-elevated shell setup relaunches itself elevated
under a new pid — and a non-elevated pywinauto cannot send input to that higher-integrity
window at all (UIPI), nor click the UAC secure desktop. Start elevated.

The trade: no UAC prompt appears in the take, but b03's SCREEN direction calls for one.
Either shoot the double-click + "click yes" as a separate hand-performed take, or let
b03's narration ride the wizard pages — it reads cleanly over them.

### The wizard no longer stops for pairing

Since 3.0.0 the wizard does **not** block on a pairing console. At `ssPostInstall` it
installs the WebView2 runtime, installs the PawnIO driver, hands pairing to
`owlette-desktop.exe --pair` with `ewNoWait`, then installs the service — and reaches its
finish page. So:

- the install phase is **minutes** on a clean box, which is why the scene polls for the
  finish page instead of dwelling a fixed number of seconds;
- the pairing phrase (b05), the "open owlette.app/add" button (b06) and the recovery
  reopen (b10) are all in the app's dialog, filmed with the CDP harness — not here, and
  not in a console;
- the visible `configure_site.py` console only survives for `/ADD=` bulk installs and
  machines with no WebView2 runtime. You will not see it on this episode's path.

### Which progress captions you get is a VM-state decision

`Installing the WebView2 runtime...` and `Installing the PawnIO driver...` only appear on
a machine missing those components; `Installing Owlette service...` always appears. b04's
narration describes all three, so shoot on a clean image **with internet** — the WebView2
bootstrapper runs before the pairing handoff, so the runtime is back in place by the time
the handoff checks for it and b05 still gets the app dialog rather than the console
fallback.

### Tuning to your build

Inno control names vary between builds, so the button titles in the scene ("Next",
"Install", "Finish") are tried as a list of variants. To see the real control tree:

```powershell
$env:DUMP = "1"
python scenes\install_and_pair.py
```

Prefer `class_name="TWizardForm"` / control-type locators over English captions when you
adjust them — captions are the part that moves.

## The tray icon and its menu

Handled by `web/e2e/desktop-screenshots/capture-tray-menu.ps1` (UIA from PowerShell:
find the notification-area button whose tooltip starts `owlette v`, right-click, render
the popup). Tauri's `tray-icon` feature (`desktop/src-tauri/Cargo.toml`) drives the same
`Shell_NotifyIcon` notification area the python tray used, so the method survived 3.0.0
unchanged. Two hard-won rules —
keep them whether you re-drive this from PowerShell or port it to pywinauto:

- **Do not poll UI Automation while the popup menu is opening.** Polling every 150 ms
  stops the menu appearing at all; a single lookup ~1.2 s after the click finds it every
  time.
- **Render with `PrintWindow` + `PW_RENDERFULLCONTENT`, never `CopyFromScreen`.** The
  screen-copy path ghosted the menu over an offset copy of itself in one run of six.

## Helpers (`recorder.py`)

| Helper | What it does |
|---|---|
| `beat(seconds, label)` | dwell so a beat's narration MP3 fits underneath (native analog of the web `narrate()`) |
| `smooth_move(x, y)` / `move_click(control)` | glide the real cursor so motion reads on camera, then click |
| `slow_type(text)` | type one key at a time into the focused control |
| `dump_identifiers(window)` | print a control tree to find real control names |
| `ScreenRecorder(out)` | optional ffmpeg gdigrab desktop recorder (`.start()` / `.stop()`) |

Dwell budgets are derived from the **rendered** voiceover, never guessed:

```powershell
ffprobe -v error -show_entries format=duration -of csv=p=0 `
  ..\voiceover\out\03-install-and-pair\ep03-b04.mp3
```

Round up ~0.5 s per beat and put the number in a named constant next to the ffprobe
command that produced it, the way `scenes/install_and_pair.py` does — a re-voiced beat
then has one obvious place to update.

## Scenes

- `scenes/install_and_pair.py` — episode 3, the installer wizard (b01 / b03 / b04). The
  only native scene the current series needs.

Everything else in episode 3 is web (`web/e2e/videos/`, no ep3 scene written yet) or the
desktop app over CDP. Episode 9 ("the owlette app") is entirely the CDP harness plus the
tray script above.
