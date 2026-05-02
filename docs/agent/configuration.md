# configuration

The agent can be configured locally via the GUI, remotely from the web dashboard, or by editing `config.json` directly. The local source file is `C:\ProgramData\Owlette\config\config.json`.

Changes from the GUI, service, and dashboard sync through Firestore within roughly 1-2 seconds.

---

## configuration gui

The GUI is a CustomTkinter application that runs as a separate process from the service. Launch it from:

- **System tray** -> Right-click -> "Open GUI"
- **Start Menu** -> owlette
- **Directly**: `C:\ProgramData\Owlette\python\pythonw.exe C:\ProgramData\Owlette\agent\src\owlette_gui.py`

### gui features

| section | controls |
|---------|----------|
| **Site Connection** | Join/leave site, connection status, site ID |
| **Processes** | Add, edit, remove monitored processes |
| **Process Settings** | Executable path, file path or arguments, working directory, priority, visibility, delays, launch mode, relaunch attempts |
| **Footer** | Config button that opens `config.json`, logs button, version info |

---

## config.json

The configuration file is stored at `C:\ProgramData\Owlette\config\config.json`.

When no config exists, the agent generates this default structure:

```json
{
    "version": "1.6.0",
    "environment": "production",
    "processes": [],
    "logging": {
        "level": "INFO",
        "max_age_days": 90,
        "firebase_shipping": {
            "enabled": false,
            "ship_errors_only": true
        }
    },
    "sentry": {
        "enabled": false,
        "dsn": ""
    },
    "displays": {
        "enabled": true,
        "assigned": null,
        "auto_enforce": false,
        "remoteApplyEnabled": false
    },
    "watchdog": {
        "enabled": true,
        "thresholds": {
            "failure_seconds": 360,
            "boot_grace_seconds": 180
        },
        "budget": {
            "max_per_window": 3,
            "window_seconds": 3600
        },
        "preconditions": {
            "require_internet": true,
            "fatal_error_suppression_seconds": 3600
        }
    }
}
```

If the agent regenerates a config and an existing `firebase` section is present, it preserves that section so pairing credentials are not lost.

### top-level fields

| field | type | editable | description |
|-------|------|----------|-------------|
| `version` | string | no | Config schema version. The agent upgrades older configs to the current schema. |
| `environment` | string | yes | `production` uses owlette.app; `development` uses dev.owlette.app. |
| `processes` | array | yes | Monitored process entries. The generator starts with an empty array. |
| `logging` | object | yes | Local log level, retention, and optional Firebase log shipping. |
| `sentry` | object | yes | Optional Sentry reporting settings. |
| `displays` | object | yes | Display-topology monitoring and remote apply settings. |
| `watchdog` | object | yes | Service watchdog thresholds, restart budget, and restart preconditions. |
| `firebase` | object | no | Pairing and cloud-sync state. The agent may preserve or write this section, but users should not edit it manually. |

### logging fields

| field | type | default | description |
|-------|------|---------|-------------|
| `logging.level` | string | `"INFO"` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`. |
| `logging.max_age_days` | number | `90` | Delete local log files older than this many days. |
| `logging.firebase_shipping.enabled` | boolean | `false` | Sends buffered logs to Firebase when enabled. |
| `logging.firebase_shipping.ship_errors_only` | boolean | `true` | When shipping is enabled, sends only error and critical logs unless set to `false`. |

### user-editable sections

| section | keys |
|---------|------|
| `environment` | `"production"` or `"development"` |
| `sentry` | `enabled`, `dsn` |
| `displays` | `enabled`, `assigned`, `auto_enforce`, `remoteApplyEnabled` |
| `watchdog.thresholds` | `failure_seconds`, `boot_grace_seconds` |
| `watchdog.budget` | `max_per_window`, `window_seconds` |
| `watchdog.preconditions` | `require_internet`, `fatal_error_suppression_seconds` |

---

## process configuration

Each process in the `processes` array uses the current process keys. The generator creates an empty array; this is the shape written by the GUI and dashboard when a process is added:

```json
{
    "id": "b8f1a4d2-8b1e-4df9-b7ff-7d4c3c10f9f1",
    "name": "TouchDesigner",
    "exe_path": "C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe",
    "file_path": "C:\\Projects\\MyProject.toe",
    "cwd": "C:\\Projects",
    "priority": "Normal",
    "visibility": "Normal",
    "time_delay": "0",
    "time_to_init": "10",
    "relaunch_attempts": "5",
    "launch_mode": "always",
    "autolaunch": true,
    "schedules": null
}
```

### process fields

| field | type | description |
|-------|------|-------------|
| `id` | string | Stable UUID for the process entry. |
| `name` | string | Display name for the process. |
| `exe_path` | string | Full path to the executable. |
| `file_path` | string | File to open with the executable, or command-line arguments when the value is not a file on disk. |
| `cwd` | string or null | Working directory. Empty string and null are treated as unset. |
| `priority` | string | Priority label stored with the process. The GUI exposes `Low`, `Normal`, `High`, and `Realtime`. |
| `visibility` | string | Window state used by the launcher. See accepted values below. |
| `time_delay` | string or number | Seconds to wait before launching this process during startup or scheduled activation. |
| `time_to_init` | string or number | Seconds to wait after launch before monitoring responsiveness. |
| `relaunch_attempts` | string or number | Restart-attempt budget. `0` means unlimited relaunch attempts. |
| `launch_mode` | string | `off`, `always`, or `scheduled`. |
| `autolaunch` | boolean | Backward-compatible flag derived from `launch_mode`. Keep it aligned with `launch_mode != "off"`. |
| `schedules` | array or null | Schedule blocks for `launch_mode: "scheduled"`. Null means no schedule is configured. |

### visibility options

The local GUI exposes `Normal` and `Hidden`. The launcher also accepts `Minimized` and `Maximized` when a process entry is edited manually.

| value | description |
|-------|-------------|
| `"Normal"` | Standard visible window. |
| `"Hidden"` | Hidden process. Console apps are launched without a visible console window. |
| `"Minimized"` | Visible window starts minimized. |
| `"Maximized"` | Visible window starts maximized. |

Legacy `Show` and `Hide` values are normalized by the service to `Normal` and `Hidden`.

---

## web-based configuration

From the dashboard, you can edit process settings remotely:

1. Click on a machine in the dashboard.
2. Click on a process to open the process dialog.
3. Edit settings such as name, paths, priority, visibility, delays, launch mode, and schedules.
4. Click **Save**.

The dashboard writes process updates to Firestore. The agent listener applies the new configuration locally and writes the updated config file without requiring a service restart.

---

## configuration sync

```text
                  Cloud Firestore
             config and machine state
                         |
          +--------------+--------------+
          |              |              |
      local GUI       service       dashboard
      config.json    config.json    web writes
```

- **GUI -> service**: The GUI writes to `config.json`; the service detects the file change.
- **Service -> Firestore**: The service uploads local config changes.
- **Firestore -> service**: The service listener applies remote config changes.
- **Dashboard -> Firestore**: The dashboard writes config changes directly to Firestore.
- **Hash tracking** prevents feedback loops when a local config change is echoed back from Firestore.

!!! warning "Don't modify the firebase section remotely"
    The `firebase` section of `config.json` is protected. Remote config updates never overwrite it. Changing it manually can break the agent's connection to Firestore.
