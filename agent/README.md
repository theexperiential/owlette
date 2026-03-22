# Owlette Agent - Windows Service

The Owlette Agent is a Python-based Windows service that monitors and manages processes, with cloud integration via Firebase.

## Features

- **Process Monitoring**: Automatically restart crashed or frozen applications
- **Firebase Integration**: Real-time cloud communication and remote control
- **Offline Resilient**: Continues operating from cached config when offline
- **System Metrics**: Reports CPU, memory, disk, and GPU usage to cloud
- **Remote Commands**: Restart/kill processes from web dashboard
- **Remote Screenshots**: Capture and send screenshots to the dashboard
- **MCP Tools**: Tool-calling support for the Cortex AI assistant
- **Self-Update**: Update the agent remotely from the web dashboard
- **OAuth Authentication**: Secure token-based auth with the Owlette Dashboard

---

## Quick Start

### Prerequisites

- Windows 10/11 or Windows Server
- Python 3.9+ (installer will auto-install if missing)
- Firebase project with Firestore enabled

### Installation

1. **Run the installer** (recommended):

   Download the installer from the Owlette web dashboard. It handles everything:
   - Installs embedded Python runtime and all dependencies
   - Opens browser for OAuth authorization
   - Registers the agent with your site
   - Installs and starts the Windows service

   See [INSTALLER-USAGE.md](INSTALLER-USAGE.md) for the full OAuth flow documentation.

2. **Configure processes** (optional):
   - Use the GUI: `python src/owlette_gui.py`
   - Or manage from the web dashboard

3. **Connect to Owlette Dashboard**:
   - The installer automatically opens your browser for OAuth authorization
   - Log in and authorize the agent
   - Installation completes automatically with secure token storage

---

## Configuration

### config/config.json

```json
{
  "version": "2.2.0",
  "processes": [
    {
      "id": "unique-id-here",
      "name": "My Application",
      "exe_path": "C:\\Path\\To\\Application.exe",
      "file_path": "C:\\Path\\To\\file.toe",
      "cwd": "C:\\Working\\Directory",
      "time_delay": 0,
      "time_to_init": 10,
      "relaunch_attempts": 3,
      "autolaunch": true,
      "visibility": "Show",
      "priority": "Normal"
    }
  ],
  "firebase": {
    "enabled": true,
    "site_id": "your-site-id"
  }
}
```

### Process Settings

| Setting | Description | Values |
|---------|-------------|--------|
| `name` | Display name for the process | Any string |
| `exe_path` | Full path to executable | `C:\Path\To\app.exe` |
| `file_path` | File to open or command-line args | `C:\file.ext` or `--args` |
| `cwd` | Working directory | `C:\Working\Dir` |
| `time_delay` | Delay before launch (seconds) | `0`, `5`, `10`, etc. |
| `time_to_init` | Time to initialize before checking responsiveness | `10`, `30`, `60`, etc. |
| `relaunch_attempts` | Max restart attempts before system reboot | `3`, `5`, `10`, etc. |
| `autolaunch` | Auto-start on service start | `true` or `false` |
| `visibility` | Window visibility | `"Show"` or `"Hide"` |
| `priority` | Process priority | `"Low"`, `"Normal"`, `"High"`, `"Realtime"` |
| `check_responsive` | Enable "not responding" detection | `true` (default) or `false` |

### Firebase Settings

| Setting | Description |
|---------|-------------|
| `enabled` | Enable Firebase cloud features |
| `site_id` | Unique identifier for this site/location |

**Authentication:** Modern installations use OAuth authentication (no manual credentials needed). Tokens are stored securely in encrypted local storage. See [INSTALLER-USAGE.md](INSTALLER-USAGE.md) for the OAuth flow details.

---

## Manual Installation Steps

If the installer doesn't work, follow these manual steps:

1. **Install Python 3.9+**
   ```cmd
   # Download from python.org and install
   ```

2. **Install dependencies**
   ```cmd
   cd agent
   pip install -r requirements.txt
   ```

3. **Create folders**
   ```cmd
   mkdir config
   mkdir logs
   mkdir tmp
   ```

4. **Create config file**
   ```cmd
   copy config.template.json config\config.json
   ```

5. **Connect to Owlette Dashboard** (optional but recommended)
   - Use the OAuth installer from the web dashboard (recommended)
   - Or for manual/development setups, see [INSTALLER-USAGE.md](INSTALLER-USAGE.md)

6. **Install service**
   ```cmd
   cd src
   python owlette_service.py install
   sc config OwletteService start= delayed-auto
   python owlette_service.py start
   ```

---

## Development

### Running Without Installing Service

For development/testing:

```cmd
cd agent/src
python owlette_service.py debug
```

**Note:** Requires administrator privileges to access Windows service APIs.

### Version Management

**Single Source of Truth: `agent/VERSION` file**

To bump the version across all components:

```bash
node scripts/sync-versions.js 2.3.0
```

The version automatically propagates to:
- System tray display (`owlette_tray.py`)
- Configuration GUI (`owlette_gui.py`)
- Firestore agent registration (`firebase_client.py`)
- OAuth device registration (`auth_manager.py`)
- Installer filename (`Owlette-Installer-v2.2.0.exe`)

**How it works:**
- `shared_utils.py` reads `VERSION` file at runtime
- Build script reads `VERSION` and passes to Inno Setup compiler
- All code imports version from `shared_utils.APP_VERSION`

### Building the Installer

You have two options for building the installer:

#### Option 1: Full Build (First Time / Clean Build)

```cmd
cd agent
build_installer_full.bat
```

**What it does:**
- Downloads Python 3.11 embedded (~25 MB)
- Installs all dependencies
- Copies source files
- Downloads NSSM service manager
- Compiles installer with Inno Setup

**Time:** ~5-10 minutes
**When to use:** First build, after dependency changes, or for clean builds

#### Option 2: Quick Build (Development Iteration)

```cmd
cd agent
build_installer_quick.bat
```

**What it does:**
- Validates VERSION file
- Copies updated source files only
- Runs Inno Setup compiler

**Time:** ~30 seconds
**When to use:** After code changes (Python files, scripts, icons)

**Prerequisites:** Must run full build at least once to set up build/ directory

**Output:** Both scripts produce `build\installer_output\Owlette-Installer-v{VERSION}.exe`

---

## Service Management

### Start/Stop/Restart

```cmd
net start OwletteService
net stop OwletteService
net start OwletteService  # Restart
```

### Check Status

```cmd
sc query OwletteService
```

### View Logs

Check `logs/service.log` for service activity:
```cmd
type logs\service.log
```

### Uninstall

```cmd
uninstall.bat
```

Or manually:
```cmd
cd src
python owlette_service.py stop
python owlette_service.py remove
```

---

## Troubleshooting

### Service won't start

1. **Check logs**: `logs/service.log`
2. **Verify Python**: `python --version` should be 3.9+
3. **Check permissions**: Service needs admin rights
4. **Check OAuth tokens**: Ensure agent completed OAuth authorization

### Processes won't launch

1. **Check paths**: Ensure `exe_path` and `file_path` are correct
2. **Check permissions**: Service runs as SYSTEM but launches as logged-in user
3. **Check logs**: Look for errors in `logs/service.log`
4. **Increase `time_to_init`**: Some apps need more time to start

### Dashboard not connecting

1. **Check authentication**: Ensure OAuth authorization completed successfully
2. **Check tokens**: Tokens stored in encrypted local storage (use `auth_manager.py` to verify)
3. **Check internet**: Service needs internet to connect to dashboard
4. **Check config**: Ensure `firebase.enabled` is `true` in `config/config.json`
5. **Check logs**: Look for authentication errors in `logs/service.log`
6. **Offline mode**: Service will continue with cached config if dashboard unavailable
7. **Re-authenticate**: Run installer again to refresh OAuth tokens if expired

### "Access Denied" errors

- Service commands require administrator privileges
- Right-click Command Prompt -> "Run as administrator"

---

## File Structure

```
agent/
├── src/                           # Python source code (24 modules)
│   ├── owlette_service.py         # Main Windows service
│   ├── owlette_runner.py          # Process lifecycle management
│   ├── owlette_gui.py             # Configuration GUI
│   ├── owlette_tray.py            # System tray icon
│   ├── owlette_scout.py           # System metrics collector
│   ├── firebase_client.py         # Firebase integration & sync
│   ├── firestore_rest_client.py   # Firestore REST API client
│   ├── connection_manager.py      # Connection state machine & reconnect
│   ├── auth_manager.py            # OAuth token management
│   ├── secure_storage.py          # Encrypted credential storage
│   ├── shared_utils.py            # Shared utilities & constants
│   ├── process_launcher.py        # Process start/stop logic
│   ├── session_exec.py            # User-session process execution
│   ├── health_probe.py            # Health check endpoint
│   ├── mcp_tools.py               # Cortex AI tool implementations
│   ├── configure_site.py          # Site join/leave OAuth flow
│   ├── installer_utils.py         # Remote deployment handler
│   ├── project_utils.py           # Project distribution handler
│   ├── registry_utils.py          # Windows registry operations
│   ├── cleanup_commands.py        # Command queue cleanup
│   ├── start_service.py           # Service startup helper
│   ├── prompt_restart.py          # Restart countdown dialog
│   ├── CTkMessagebox.py           # Custom message box widget
│   └── custom_messagebox.py       # PyQt6 message box widget
├── tests/                         # pytest tests
├── config/                        # Configuration (gitignored)
│   └── config.json                # Main config
├── logs/                          # Log files (gitignored)
│   └── service.log
├── tmp/                           # Temporary files (gitignored)
├── build_installer_full.bat       # Full build script
├── build_installer_quick.bat      # Quick build script
├── install.bat                    # Installation script
├── uninstall.bat                  # Uninstallation script
├── owlette_installer.iss          # Inno Setup script
├── requirements.txt               # Python dependencies
├── config.template.json           # Config template
├── VERSION                        # Agent version file
└── README.md                      # This file
```

---

## Developer Documentation

### Building the Installer

See [BUILD.md](BUILD.md) for comprehensive instructions on building the installer:

- **Full Build**: Complete rebuild with embedded Python (~5-10 min)
- **Quick Build**: Fast iteration during development (~30 sec)
- Testing procedures and troubleshooting

### End-User Documentation

- **[INSTALLER-USAGE.md](INSTALLER-USAGE.md)** - Installation guide for end users
  - Environment selection (dev/prod)
  - OAuth authentication flow
  - Silent installation
  - Troubleshooting

---

## Support

- **Documentation**: See [docs/](../docs/) folder
- **Issues**: https://github.com/theexperiential/Owlette/issues
- **Firebase Setup**: [docs/setup/firebase.md](../docs/setup/firebase.md)

---

## License

See [LICENSE](../LICENSE) in the root directory.
