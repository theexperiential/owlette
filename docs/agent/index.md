# agent

The owlette agent is a Python Windows service that runs in the background, monitoring your processes, collecting system metrics, and syncing everything to the cloud. It's the core of the owlette system — every machine you want to manage needs an agent installed.

---

## what the agent does

| function | frequency | description |
|----------|-----------|-------------|
| **Process monitoring** | Every 5s | Checks if configured processes are running, detects crashes and stalls |
| **Auto-restart** | On crash | Restarts crashed processes using Task Scheduler or CreateProcessAsUser |
| **Heartbeat** | Every 30s | Marks the machine as online in Firestore |
| **Metrics** | Every 60s | Reports CPU, memory, disk, and GPU usage |
| **Commands** | Event-driven | Listens for and executes commands from the dashboard |
| **Config sync** | Event-driven | Syncs configuration changes between GUI, service, and cloud |

---

## how it runs

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
              ├── health_probe.py (Startup Health Checks)
              ├── installer_utils.py (Remote Deployment)
              ├── project_utils.py (Project Distribution)
              ├── registry_utils.py (Software Inventory)
              └── mcp_tools.py (Remote Command Execution)

Spawned into user session by the service:
  ├── owlette_tray.py (System Tray Icon)
  ├── owlette_cortex.py (Local AI Agent)
  │     ├── cortex_firestore.py (Message Polling & Response Writing)
  │     ├── cortex_tools.py (MCP Tool Server for Agent SDK)
  │     └── mcp_tools.py (19 Tool Implementations)
  ├── process_launcher.py (Application Launcher)
  └── session_exec.py (User Session Command Executor)

Launched on demand:
  ├── owlette_gui.py (Configuration GUI)
  ├── configure_site.py (Device Code Pairing)
  └── report_issue.py (Bug Report Dialog)
```

---

## service lifecycle

### startup

1. Initialize logging (RotatingFileHandler, 10 MB per file, 5 backups)
2. Upgrade config schema if needed (automatic migration)
3. Initialize Firebase client (lazy, soft-fail if no credentials)
4. Recover running processes (adopt PIDs from previous session)
5. Launch system tray icon as user process
6. Launch Cortex process as user process (if enabled)
7. Enter main loop

### main loop (every 5 seconds)

1. Check all configured processes — detect crashes, stalls, exits
2. Auto-restart any crashed processes (if autolaunch enabled)
3. Process any pending commands from Firestore
4. Ensure Cortex is running (if enabled)
5. Process Cortex IPC commands (Tier 2 tool calls)
6. Check for Firebase state changes (enable/disable)

### shutdown

1. Mark machine offline in Firestore
2. Terminate Cortex process
3. Stop Firebase client and background threads
4. Clean up resources

---

## key directories

| path | contents |
|------|----------|
| `C:\ProgramData\Owlette\` | Installation root |
| `C:\ProgramData\Owlette\agent\src\` | Python source code |
| `C:\ProgramData\Owlette\agent\config\` | `config.json` and credentials |
| `C:\ProgramData\Owlette\logs\` | Service and GUI log files |
| `C:\ProgramData\Owlette\python\` | Embedded Python interpreter |
| `C:\ProgramData\Owlette\nssm\` | NSSM service manager binary |

