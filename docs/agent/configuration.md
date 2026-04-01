# Configuration

The agent can be configured locally via the GUI, remotely from the web dashboard, or by editing `config.json` directly. Changes from any source sync to all others within ~1-2 seconds.

---

## Configuration GUI

The GUI is a CustomTkinter application that runs as a separate process from the service. Launch it from:

- **System tray** → Right-click → "Open GUI"
- **Start Menu** → Owlette
- **Directly**: `C:\ProgramData\Owlette\python\pythonw.exe C:\ProgramData\Owlette\agent\src\owlette_gui.py`

### GUI Features

| Section | Controls |
|---------|----------|
| **Site Connection** | Join/Leave site, connection status, site ID |
| **Processes** | Add, edit, remove monitored processes |
| **Process Settings** | Executable path, arguments, priority, visibility, delays |
| **Footer** | Config button (opens config.json), Logs button (opens logs folder), version info |

---

## config.json

The configuration file is stored at `C:\ProgramData\Owlette\agent\config\config.json`.

### Top-Level Structure

```json
{
  "version": "1.5.0",
  "environment": "production",
  "firebase": {
    "enabled": true,
    "site_id": "your-site-id"
  },
  "processes": [...],
  "logging": {
    "level": "INFO",
    "max_file_size_mb": 10,
    "max_backup_count": 5,
    "cleanup_days": 90
  }
}
```

### Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Config schema version (auto-upgraded) |
| `environment` | string | `"production"` (owlette.app) or `"development"` (dev.owlette.app) |
| `firebase.enabled` | boolean | Whether cloud sync is active |
| `firebase.site_id` | string | The site this machine belongs to |
| `processes` | array | List of monitored processes (see below) |
| `logging.level` | string | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `logging.max_file_size_mb` | number | Max log file size before rotation (default: 10) |
| `logging.max_backup_count` | number | Number of rotated log files to keep (default: 5) |
| `logging.cleanup_days` | number | Delete log files older than this (default: 90) |

---

## Process Configuration

Each process in the `processes` array has these settings:

```json
{
  "name": "TouchDesigner",
  "exe_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe",
  "file_path": "C:\\Projects\\MyProject.toe",
  "command_line_args": "",
  "autolaunch": true,
  "priority": "Normal",
  "visibility": "Normal",
  "launch_delay": 0,
  "init_time": 10,
  "relaunch_attempts": 5
}
```

### Process Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Display name for the process |
| `exe_path` | string | required | Full path to the executable |
| `file_path` | string | `""` | File to open with the executable (e.g., `.toe` project file) |
| `command_line_args` | string | `""` | Additional command-line arguments |
| `autolaunch` | boolean | `true` | Whether to auto-start and auto-restart this process |
| `priority` | string | `"Normal"` | Windows process priority class |
| `visibility` | string | `"Normal"` | Window visibility mode |
| `launch_delay` | number | `0` | Seconds to wait before launching (useful for startup ordering) |
| `init_time` | number | `10` | Seconds to wait after launch before monitoring responsiveness |
| `relaunch_attempts` | number | `5` | Max restart attempts before prompting for system reboot |

### Priority Options

| Value | Description |
|-------|-------------|
| `"Idle"` | Lowest priority — only runs when CPU is idle |
| `"Below Normal"` | Lower than normal |
| `"Normal"` | Default Windows priority |
| `"Above Normal"` | Higher than normal |
| `"High"` | High priority — use with caution |
| `"Realtime"` | Highest priority — can starve other processes |

### Visibility Options

| Value | Description |
|-------|-------------|
| `"Normal"` | Standard visible window |
| `"Hidden"` | No visible window (uses VBScript wrapper for console apps) |

---

## Web-Based Configuration

From the dashboard, you can edit process settings remotely:

1. Click on a machine in the dashboard
2. Click on a process to open the **Process Dialog**
3. Edit settings (name, path, arguments, priority, etc.)
4. Click **Save**

Changes propagate through Firestore to the agent within ~1-2 seconds. The agent applies the new configuration without restarting.

---

## Configuration Sync

```
                    ┌─────────────────┐
                    │  Cloud Firestore │
                    │  config/{siteId} │
                    │  /machines/{id}  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │   GUI    │  │  Service │  │Dashboard │
        │  (local) │  │  (local) │  │  (web)   │
        └──────────┘  └──────────┘  └──────────┘
```

- **GUI → Service**: GUI writes to `config.json`, service detects file change
- **Service → Firestore**: Service uploads config on change
- **Firestore → Service**: Service listener detects cloud config changes
- **Dashboard → Firestore**: Dashboard writes directly to Firestore
- **MD5 hash tracking** prevents feedback loops (config changes originated locally aren't re-processed when echoed back from Firestore)

!!! warning "Don't modify the firebase section remotely"
    The `firebase` section of `config.json` is protected — remote config updates never overwrite it. Changing it remotely would break the agent's connection to Firestore.
