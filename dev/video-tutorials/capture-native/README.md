# Native capture (installer / agent GUI / tray)

The half of the pipeline Playwright can't reach. Owlette's installer (Inno Setup) and
agent GUI + tray (Tkinter / notification area) are native windows; **pywinauto** drives
them — it's the desktop equivalent of Playwright, and the maintained 2026 choice
(WinAppDriver is paused; FlaUI is .NET-only).

Windows-only. Run on the disposable demo machine.

## Setup

**Machine-level prep first** — display/DPI pinning, lock/sleep/power, RDP discipline, UAC,
and the `pywin32==306` pin (why it must never be upgraded) are documented once in
[dev/active/full-machine-e2e/machine-setup.md](../../active/full-machine-e2e/machine-setup.md)
(Profiles A + B). That doc is canonical for machine prep; this README only covers the
capture workflow itself.

```powershell
cd dev\video-tutorials\capture-native
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Record a native scene

pywinauto *drives* the app (moves the real cursor, types, clicks). You *capture* with
OBS (recommended — highest quality, and you control start/stop) or the optional
`ScreenRecorder` (ffmpeg gdigrab) in `recorder.py`.

```powershell
# 1. start OBS recording (or rely on ScreenRecorder inside the scene)
# 2. from an ELEVATED powershell (installer needs UAC):
python scenes\install_and_pair.py            # uses newest agent/build/installer_output/*.exe
python scenes\install_and_pair.py C:\path\to\Owlette-Installer-v3.0.0.exe
# 3. stop OBS
```

### UAC

Owlette installs a service, so the installer triggers a UAC prompt. pywinauto **cannot**
click the secure-desktop UAC dialog. Either run the scene from an already-elevated shell,
or click UAC by hand once (the scene waits a couple of seconds after launch for exactly
this).

### Tuning to your build

Inno Setup control names vary between builds, so the button titles in the example scene
("Next", "Install", "Finish") are best-effort. To see the real control tree:

```powershell
set DUMP=1
python scenes\install_and_pair.py
```

That prints the live wizard's controls (via `dump_identifiers`); copy the real titles
into `click_button(...)` calls.

## Helpers (`recorder.py`)

| Helper | What it does |
|---|---|
| `beat(seconds, label)` | dwell so a beat's narration MP3 fits underneath (native analog of the web `narrate()`) |
| `smooth_move(x, y)` / `move_click(control)` | glide the real cursor so motion reads on camera, then click |
| `slow_type(text)` | type one key at a time into the focused control |
| `dump_identifiers(window)` | print a control tree to find real control names |
| `ScreenRecorder(out)` | optional ffmpeg gdigrab desktop recorder (`.start()` / `.stop()`) |

## Scenes to add (mirror the scripts)

- `install_and_pair.py` — episode 2, installer half *(example, included)*.
- `agent-tray-and-gui.py` — episode 8: right-click the tray menu (service/firebase
  status, open gui, restart service), then drive the Tkinter GUI (add/edit/save a
  process, schedule editor). Connect with `Application(backend="uia").connect(title_re="Owlette")`.

The browser pairing (episode 2, b06–b09) is a production web flow — capture it live with
OBS rather than driving it here.
