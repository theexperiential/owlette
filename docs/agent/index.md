# Agent

The Owlette agent is a Python Windows service that runs in the background, monitoring your processes, collecting system metrics, and syncing everything to the cloud. It's the core of the Owlette system — every machine you want to manage needs an agent installed.

---

## What the Agent Does

| Function | Frequency | Description |
|----------|-----------|-------------|
| **Process monitoring** | Every 10s | Checks if configured processes are running, detects crashes and stalls |
| **Auto-restart** | On crash | Restarts crashed processes using Task Scheduler or CreateProcessAsUser |
| **Heartbeat** | Every 30s | Marks the machine as online in Firestore |
| **Metrics** | Every 60s | Reports CPU, memory, disk, and GPU usage |
| **Commands** | Event-driven | Listens for and executes commands from the dashboard |
| **Config sync** | Event-driven | Syncs configuration changes between GUI, service, and cloud |

---

## How It Runs

The agent runs as a Windows service managed by [NSSM](https://nssm.cc/) (Non-Sucking Service Manager). NSSM ensures the service starts automatically on boot and restarts on failure.

```
NSSM (Service Manager)
  └── owlette_runner.py (Bridge)
        └── owlette_service.py (Main Service Loop)
              ├── firebase_client.py (Cloud Sync)
              │     ├── auth_manager.py (OAuth Tokens)
              │     ├── firestore_rest_client.py (REST API)
              │     └── connection_manager.py (State Machine)
              ├── shared_utils.py (Config, Logging, Metrics)
              ├── installer_utils.py (Remote Deployment)
              └── project_utils.py (Project Distribution)

owlette_gui.py (Configuration GUI — separate process)
owlette_tray.py (System Tray Icon — separate process)
```

---

## Service Lifecycle

### Startup

1. Initialize logging (RotatingFileHandler, 10 MB per file, 5 backups)
2. Upgrade config schema if needed (automatic migration)
3. Initialize Firebase client (lazy, soft-fail if no credentials)
4. Recover running processes (adopt PIDs from previous session)
5. Launch system tray icon as user process
6. Enter main loop

### Main Loop (every 10 seconds)

1. Check all configured processes — detect crashes, stalls, exits
2. Auto-restart any crashed processes (if autolaunch enabled)
3. Process any pending commands from Firestore
4. Check for Firebase state changes (enable/disable)

### Shutdown

1. Mark machine offline in Firestore
2. Stop Firebase client and background threads
3. Clean up resources

---

## Key Directories

| Path | Contents |
|------|----------|
| `C:\ProgramData\Owlette\` | Installation root |
| `C:\ProgramData\Owlette\agent\src\` | Python source code |
| `C:\ProgramData\Owlette\agent\config\` | `config.json` and credentials |
| `C:\ProgramData\Owlette\logs\` | Service and GUI log files |
| `C:\ProgramData\Owlette\python\` | Embedded Python interpreter |
| `C:\ProgramData\Owlette\nssm\` | NSSM service manager binary |

---

## In This Section

- [**Installation**](installation.md) — How to install the agent (automatic, remote, manual)
- [**Configuration**](configuration.md) — GUI tool, config.json, process settings
- [**Process Monitoring**](process-monitoring.md) — State machine, crash detection, auto-restart
- [**System Tray**](system-tray.md) — Tray icon behavior and menu
- [**Remote Commands**](remote-commands.md) — All commands the agent accepts
- [**Self-Update**](self-update.md) — Remote agent updates
- [**Troubleshooting**](troubleshooting.md) — Common issues and log locations
