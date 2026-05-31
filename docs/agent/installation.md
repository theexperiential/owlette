# installation

There are four supported ways to install or update the owlette agent on a Windows machine:

1. Interactive packaged installer for a single machine
2. Silent packaged installer with `/ADD=` for bulk enrollment
3. Remote deployment to machines that already run the agent
4. Manual packaged repair or source-development setup

---

## method 1: interactive packaged install

Download the packaged installer, run it as Administrator, and authorize the machine with the device-code pairing flow.

### steps

1. Log into the owlette dashboard.
2. Click the download button in the header bar.
3. Save `Owlette-Installer-v<version>.exe` to the target machine.
4. Right-click the installer and select **Run as administrator**.
5. Follow the installer wizard.
6. When the console appears, copy the pairing phrase and note the authorization URL.
7. At the prompt `open browser on this machine? [y/N]`, choose:
    - `y` to open the pairing page locally, then select a site and authorize.
    - Enter to keep the browser closed, then enter the phrase from your phone or another computer.
8. Wait while the agent polls for authorization, stores credentials, and installs the Windows service.

Pairing phrases expire after 10 minutes. Credentials are stored encrypted at `C:\ProgramData\Owlette\.tokens.enc`.

---

## method 2: silent install with `/ADD=`

Use this path for bulk deployment when an admin has already generated and authorized a pairing phrase.

### steps

1. In the dashboard, click the `+` button next to the view toggle.
2. Open **Generate Code**.
3. Copy the pairing phrase, for example `silver-compass-drift`.
4. Run the installer on each target machine:

```cmd
Owlette-Installer-v<version>.exe /ADD=silver-compass-drift /SILENT
```

For a fully quiet install:

```cmd
Owlette-Installer-v<version>.exe /ADD=silver-compass-drift /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

The installer passes `/ADD=` to `configure_site.py --add`. The agent polls `/api/agent/auth/device-code/poll` with the phrase and completes as soon as the server returns tokens.

### installer flags

| flag | description |
|------|-------------|
| `/ADD=phrase` | Preauthorized pairing phrase for silent enrollment |
| `/SERVER=prod` | Use `https://owlette.app/api`; this is the default |
| `/SERVER=dev` | Use `https://dev.owlette.app/api` |
| `/SILENT` | Minimal UI with progress only |
| `/VERYSILENT` | No installer UI |
| `/SUPPRESSMSGBOXES` | Suppress message boxes |
| `/DIR="C:\path"` | Custom install directory |
| `/NORESTART` | Do not restart after installation |
| `/LOG="C:\path\setup.log"` | Write an Inno Setup log to the chosen path |

Example for the dev environment:

```cmd
Owlette-Installer-v<version>.exe /SERVER=dev /ADD=silver-compass-drift /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

---

## method 3: remote deployment or upgrade

Remote deployment requires a target machine that already has a running owlette agent. The agent receives an `install_software` command, downloads the installer, verifies its SHA-256 checksum, and then executes it with the provided silent flags.

Required fields for an owlette agent upgrade:

| field | required | notes |
|-------|----------|-------|
| `installer_url` | yes | Direct URL to the installer `.exe` |
| `installer_name` | no | Defaults to `installer.exe` when omitted |
| `silent_flags` | no | Use installer flags such as `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` |
| `sha256_checksum` | yes | 64-character SHA-256 of the installer; the agent refuses remote installs without it |
| `verify_path` | no | Optional path checked after installation |
| `timeout_seconds` | no | Defaults to 2400 seconds |

Example command payload:

```json
{
  "installer_url": "https://downloads.example.com/Owlette-Installer-v<version>.exe",
  "installer_name": "Owlette-Installer-v<version>.exe",
  "silent_flags": "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=prod",
  "sha256_checksum": "<64-character sha256>",
  "verify_path": "C:\\ProgramData\\Owlette\\agent\\src\\owlette_service.py",
  "timeout_seconds": 2400
}
```

In the dashboard deployment flow, provide the same installer URL, silent flags, checksum, optional verify path, and target machines before starting the deployment.

---

## method 4: manual packaged repair or source development

There are two distinct manual flows.

### packaged installer layout

Use this only on a machine that already has the packaged layout under `C:\ProgramData\Owlette`. The service installer script expects embedded Python, NSSM, scripts, and agent source in that layout:

- `C:\ProgramData\Owlette\python\python.exe`
- `C:\ProgramData\Owlette\tools\nssm.exe`
- `C:\ProgramData\Owlette\scripts\install.bat`
- `C:\ProgramData\Owlette\agent\src\owlette_runner.py`

To re-run pairing:

```cmd
cd /d C:\ProgramData\Owlette
python\python.exe agent\src\configure_site.py
```

To repair the Windows service registration:

```cmd
cd /d C:\ProgramData\Owlette
scripts\install.bat
```

### source clone for development

A raw source clone does not include the packaged `python\`, `tools\`, or installed service layout. Use it for development, testing, or building a new installer package:

```cmd
git clone https://github.com/theexperiential/owlette.git
cd owlette\agent
python -m pip install -r requirements.txt
```

Do not run `agent\scripts\install.bat` directly from a raw clone unless you have first built or staged the same packaged layout that the installer creates.

---

## how pairing works

The installer runs `configure_site.py` after copying files and before installing the service, unless an existing valid site configuration is already present.

```text
Installer runs configure_site.py
  |
  v
Agent requests a device code from the API
  |
  v
Console displays the pairing phrase, authorization URL, and 10-minute expiry
  |
  v
Prompt: open browser on this machine? [y/N]
  |
  +-- y: browser opens locally; select a site and authorize
  |
  +-- Enter: enter the phrase from another device
  |
  v
Agent polls until authorization completes or expires
  |
  v
Server returns access token, refresh token, and site ID
  |
  v
Tokens are encrypted at C:\ProgramData\Owlette\.tokens.enc
Config is written to C:\ProgramData\Owlette\config\config.json
```

Authorization options:

| method | when to use |
|--------|-------------|
| Local browser prompt | Single-machine install when the target machine has a usable browser |
| Phrase on another device | Single-machine install when the target machine is headless, locked down, or inconvenient to sign in from |
| `/ADD=` | Bulk install with a preauthorized phrase |

---

## post-installation verification

After installation, verify the agent is running.

### check windows services

1. Open Services (`Win + R`, then `services.msc`).
2. Find `OwletteService`.
3. Confirm the status is **Running**.

### check logs

```text
C:\ProgramData\Owlette\logs\service.log
C:\ProgramData\Owlette\logs\service_stdout.log
C:\ProgramData\Owlette\logs\service_stderr.log
C:\ProgramData\Owlette\logs\pairing_debug.log
```

Useful startup lines include:

```text
INFO: owlette service started successfully
INFO: Firebase client initialized for site: your_site_id
INFO: Firebase client started successfully
```

### check dashboard

The machine should appear in the selected site with:

- Online status
- CPU, memory, and disk metrics
- Agent version

### check system tray

The owlette tray icon starts through the user's Startup folder. If it is not visible, check the hidden-icons overflow menu or launch **Owlette** from the Start menu.

---

## uninstallation

Use **Windows Settings** > **Apps** > **owlette** > **Uninstall**.

The uninstaller:

1. Stops `OwletteService`.
2. Removes the NSSM service wrapper.
3. Removes the Windows Defender exclusions added by the installer.
4. Removes installed component directories: `python\`, `agent\`, `tools\`, and `scripts\`.
5. Removes installed top-level files such as `README.md` and `LICENSE`.

By default, it preserves user data under `C:\ProgramData\Owlette`, including:

- `config\`
- `logs\`
- `cache\`
- `tmp\`
- `.tokens.enc`

In non-silent uninstall mode, the uninstaller asks whether to remove all owlette configuration and data files. Accept that prompt only when you want a full cleanup. Silent uninstalls preserve data for upgrade and repair flows.

---

## installer details

The owlette installer is built with [Inno Setup](https://jrsoftware.org/isinfo.php) and bundles:

| component | purpose |
|-----------|---------|
| Embedded Python | Python runtime; no system Python is needed for packaged installs |
| NSSM | Windows service wrapper at `C:\ProgramData\Owlette\tools\nssm.exe` |
| Agent source | Python modules under `C:\ProgramData\Owlette\agent\src\` |
| Configuration GUI | Local configuration tool |
| System tray | Background tray icon for status monitoring |

---

## system requirements

| requirement | minimum |
|-------------|---------|
| OS | Windows 10 or later, 64-bit |
| RAM | 50 MB agent overhead |
| Disk | About 200 MB including embedded Python |
| Network | Access to the configured owlette API and Firebase services |
| Permissions | Administrator privileges for service installation |
