# Owlette Installer & Build System Reference

**Last Updated**: 2026-03-12
**Applies To**: `agent/` build pipeline, Inno Setup installer, NSSM service management

This document covers the complete build-to-installation pipeline. Read this before modifying any build scripts, the Inno Setup script, or the installation/update flow.

---

## Build Pipeline Overview

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 minutes | ~30 seconds |
| **Downloads Python** | Yes (3.11.8 embedded) | No (reuses existing) |
| **Installs pip/deps** | Yes | No |
| **Copies source** | Yes | Yes |
| **Compiles installer** | Yes (if Inno Setup found) | Yes (requires Inno Setup) |
| **When to use** | First build, dependency changes | Source code changes only |

**Prerequisite**: Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

---

## Full Build Steps (`build_installer_full.bat`)

```
[0/9] Read VERSION file (single source of truth)
[1/9] Clean build/ directory
[2/9] Download Python 3.11.8 embedded (python.org → build/python-embed.zip)
[3/9] Configure python311._pth (import paths for embedded runtime)
[4/9] Bootstrap pip (get-pip.py)
[5/9] Install requirements.txt (the slow step)
[6/9] Copy tkinter from system Python 3.11 (C:\Program Files\Python311)
[7/9] Download NSSM 2.24 (nssm.cc → build/nssm.zip)
[8/9] Assemble installer_package/ directory
[9/9] Compile with Inno Setup → Owlette-Installer-v{VERSION}.exe
```

### Package Structure (what gets bundled)
```
build/installer_package/
├── python/              Embedded Python 3.11 runtime (~100MB)
│   ├── python.exe       Console Python
│   ├── pythonw.exe      GUI Python (no console window)
│   ├── python311._pth   Import path configuration
│   ├── Lib/
│   │   ├── tkinter/     Copied from system Python (for GUI)
│   │   └── site-packages/  All pip dependencies
│   ├── _tkinter.pyd     Tkinter C extension
│   ├── tcl86t.dll       Tcl/Tk libraries
│   └── tcl/             Tcl runtime
├── agent/
│   ├── src/             All Python source files
│   ├── icons/           Application icons (ICO/PNG)
│   └── VERSION          Version file
├── tools/
│   └── nssm.exe         Windows service manager (v2.24)
└── scripts/
    ├── install.bat      Service installation
    ├── uninstall.bat    Service removal
    ├── launch_gui.bat   Start configuration GUI (pythonw.exe)
    └── launch_tray.bat  Start system tray icon (pythonw.exe)
```

### Embedded Python Configuration (`python311._pth`)
```
python311.zip        # Compressed standard library
.                    # Current directory
Lib                  # Standard library
Lib\site-packages    # Third-party packages
..\agent\src         # Agent source code (relative path)
import site          # Enables site.main() for pip
```

**Important**: Tkinter must be copied from a system Python 3.11 installation. The embedded distribution doesn't include it. Without tkinter at `C:\Program Files\Python311`, the GUI won't work.

---

## Inno Setup Script (`owlette_installer.iss`)

### Key Settings
- **AppId**: `{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}` (identifies Owlette in registry)
- **Default install path**: `C:\ProgramData\Owlette` (via Inno Setup `{commonappdata}` constant)
- **Compression**: LZMA2 ultra64 (~50MB output)
- **Architecture**: x64 only
- **Privileges**: Admin required
- **Version**: Read from `OWLETTE_VERSION` environment variable (set by build script)

### Installation Steps (in order)

**Step 0 — Windows Defender Exclusion**:
```powershell
Add-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\...'
```
**Why**: LibreHardwareMonitor uses WinRing0 driver for CPU/GPU temp monitoring. Windows Defender flags it as `VulnerableDriver:WinNT/Winring0` — a false positive for legitimate hardware monitoring.

**Step 1 — OAuth Configuration** (conditional):
```
python.exe configure_site.py --url "https://owlette.app/setup"
```
- **Runs if**: Fresh install OR interactive mode
- **Skipped if**: Silent mode + config already exists (self-update scenario)
- Controlled by `ShouldConfigureSite()` function
- Tracked by `DidRunOAuth` flag (affects config restore logic)

**Step 2 — Service Installation**:
```
install.bat --silent
```
- Runs AFTER OAuth completes (sequential, not parallel)

### Config Backup/Restore Logic

During upgrades, config.json must survive reinstallation:

1. `BackupConfigIfExists()` — copies config to `%TEMP%\config.json.backup` before install
2. Files are overwritten during installation
3. `RestoreConfigIfBackedUp()` — restores config UNLESS:
   - `DidRunOAuth == True` → preserve fresh OAuth config (CRITICAL: never overwrite new auth)
   - `WizardSilent() == True` → skip restore, service syncs from Firestore automatically

### Uninstallation Steps
1. `nssm stop OwletteService`
2. `nssm remove OwletteService confirm`
3. Remove Windows Defender exclusion
4. Delete installation directory
5. Prompt user about `C:\ProgramData\Owlette\` config/logs/tokens
   - Silent uninstall: always preserve (for upgrades)
   - Interactive: ask user

### Silent Install Parameters
```bash
# Production (default)
Owlette-Installer-v2.0.54.exe /SERVER=prod

# Development
Owlette-Installer-v2.0.54.exe /SERVER=dev

# Self-update (fully silent, preserves config, skips OAuth)
Owlette-Installer-v2.0.54.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS

# Custom directory
Owlette-Installer-v2.0.54.exe /DIR="D:\CustomPath\Owlette"
```

---

## OAuth Registration Flow (`configure_site.py`)

During installation, the agent authenticates via browser-based OAuth:

```
1. configure_site.py starts HTTP server on localhost:8765
2. Opens browser to https://owlette.app/setup (or dev.owlette.app)
3. User logs in and selects/creates a site
4. Web backend generates single-use registration code (24h expiry)
5. Browser redirects to http://localhost:8765/callback?site_id={id}&token={code}
6. configure_site.py calls AuthManager.exchange_registration_code()
   → POST /api/agent/auth/exchange with {registrationCode, machineId, version}
   → Receives: {accessToken, refreshToken, expiresIn, siteId}
7. Tokens encrypted to C:\ProgramData\Owlette\.tokens.enc (NOT in config.json)
8. config.json updated with firebase.enabled=true, site_id, project_id, api_base
9. Returns styled HTML success page to browser
```

**Environment detection**:
- URL contains `dev.owlette.app` → project_id: `owlette-dev-3838a`, api_base: `https://dev.owlette.app/api`
- Otherwise (production) → project_id: `owlette-prod-90a12`, api_base: `https://owlette.app/api`

---

## NSSM Service Configuration (`install.bat`)

### Service Properties
```
Service Name:    OwletteService
Display Name:    Owlette Service
Account:         LocalSystem (elevated privileges for process management)
Start Type:      SERVICE_AUTO_START
Console:         Disabled (AppNoConsole=1)
Dependencies:    Tcpip, Dnscache (waits for network)
Application:     C:\ProgramData\Owlette\python\python.exe
Arguments:       C:\ProgramData\Owlette\agent\src\owlette_runner.py
Working Dir:     C:\ProgramData\Owlette\agent\src
```

### Log Rotation
```
Stdout:          C:\ProgramData\Owlette\logs\service_stdout.log
Stderr:          C:\ProgramData\Owlette\logs\service_stderr.log
Rotate:          Daily + on size (10MB max)
```

### Restart Behavior
- **Exit code 0**: Exit (don't restart — user intentionally stopped)
- **Any other exit code**: Restart (crash recovery)

This is why `owlette_runner.py` uses `sys.exit(0)` for graceful shutdown — NSSM won't auto-restart.

---

## owlette_runner.py Bridge

**Why it exists**: NSSM manages console applications. The Owlette service uses `win32serviceutil.ServiceFramework` which is a Windows Service API. `owlette_runner.py` bridges this gap by:

1. Creating a `MockService` that mimics ServiceFramework attributes
2. Binding `OwletteService.main()` to the mock instance
3. Running `main()` as a regular Python process (NSSM-compatible)

**Signal handling is critical**: NSSM sends SIGTERM ~4 seconds before killing the process. The runner must:
- Set `is_alive = False` to break the main loop
- Log `agent_stopped` event to Firestore (happens during signal handler!)
- Call `firebase_client.stop()` to mark machine offline
- Exit with code 0

---

## Self-Update Mechanism (`owlette_updater.py`)

Triggered by `update_owlette` command from web dashboard:

```
1. Verify admin privileges and NSSM exists
2. Stop OwletteService via NSSM (wait 10s + 3s Firestore sync margin)
3. Download installer from URL
   - 3 retries with exponential backoff (5s, 10s, 20s)
   - 5-minute timeout per attempt
   - Validates file size > 1KB
   - Handles locked files (generates unique timestamped filename)
4. Execute: Owlette-Update.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS
   - 5-minute execution timeout
   - Silent mode skips OAuth (ShouldConfigureSite returns false)
   - install.bat runs → stops old service → installs new → starts
5. Cleanup temporary installer file
6. Verify service started (wait 10s, check NSSM status)
```

**Safety**: If update fails, the old service configuration remains and NSSM will restart it (non-zero exit code from updater).

---

## File System Layout After Installation

```
C:\ProgramData\Owlette\                  Installation + data directory
├── python\                              Embedded Python 3.11 runtime
├── agent\src\                           Python source code
├── agent\icons\                         Application icons
├── agent\VERSION                        Version file
├── tools\nssm.exe                       Service manager
├── scripts\                             Batch launchers
├── unins000.exe                         Inno Setup uninstaller
├── config\                              Runtime configuration
├── logs\                                Service logs (rotating)
├── cache\                               Cached data
└── tmp\                                 Temporary files
├── config\config.json                   Process + Firebase configuration
├── logs\                                All log files
│   ├── service.log                      Main service log (RotatingFileHandler)
│   ├── service_stdout.log               NSSM stdout capture
│   ├── service_stderr.log               NSSM stderr capture
│   ├── tray.log                         Tray icon log
│   ├── gui.log                          GUI log
│   ├── oauth_debug.log                  OAuth flow debug
│   └── owlette_updater.log              Update process log
├── cache\firebase_cache.json            Offline Firestore config cache
├── tmp\service_status.json              IPC status file (service → tray)
└── .tokens.enc                          Encrypted OAuth tokens (hidden file)

Start Menu\Programs\Owlette\             Shortcuts
├── Owlette Configuration                → launch_gui.bat
├── Owlette Tray Icon                    → launch_tray.bat
├── View Logs                            → C:\ProgramData\Owlette\logs\
├── Edit Configuration                   → config.json
└── Uninstall Owlette

Startup\                                 Auto-start on login
└── Owlette Tray                         → launch_tray.bat
```

---

## Version Propagation

```
agent/VERSION (single source of truth)
    ↓ build_installer_full.bat reads it
    ↓ Sets OWLETTE_VERSION environment variable
    ↓ Copies to build/installer_package/agent/VERSION
    ↓ Inno Setup reads OWLETTE_VERSION → installer filename
    ↓
Owlette-Installer-v{VERSION}.exe
    ↓ Installs to C:\ProgramData\Owlette\agent\VERSION
    ↓
Service reads at runtime: shared_utils.get_app_version()
    → Displayed in: tray icon, GUI, Firestore registration, OAuth device info
```

**To bump version**: `node scripts/sync-versions.js 2.1.0` (updates agent/VERSION + web/package.json + /VERSION)

---

## Common Build Issues

**"Python 3.11 not found"**: Tkinter copy requires system Python 3.11 at `C:\Program Files\Python311`. Install it or the GUI won't work.

**"Inno Setup not found"**: Install Inno Setup 6 from jrsoftware.org. Build script still creates the package directory without it.

**Quick build fails**: Run full build first to create the Python runtime and dependencies.

**Installer hangs during silent update**: Usually means `ShouldConfigureSite()` returned true unexpectedly. Check that config.json exists at `C:\ProgramData\Owlette\config\config.json`.

**Service won't start after update**: Check `C:\ProgramData\Owlette\logs\service_stderr.log` for Python import errors. May need a full rebuild if dependencies changed.

**"nssm.cc is unavailable and no local NSSM"**: nssm.cc goes down occasionally (503/empty response). The build script falls back to `C:\ProgramData\Owlette\tools\nssm.exe`. If that doesn't exist either, copy it from the existing Owlette installation at `C:\Owlette\tools\nssm.exe`:
```
copy C:\Owlette\tools\nssm.exe C:\ProgramData\Owlette\tools\nssm.exe
```
Then re-run the build. The fallback location is permanently seeded after the first copy.
