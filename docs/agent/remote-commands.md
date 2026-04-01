# Remote Commands

The agent listens for commands from the web dashboard via Firestore. Commands are written to a pending queue, executed by the agent, and results are written to a completed queue.

---

## Command Lifecycle

```
Dashboard                      Firestore                         Agent
  │                               │                                │
  │── write to pending ──────────▶│                                │
  │   commands/pending/{id}       │── listener detects ───────────▶│
  │                               │                                │── execute
  │                               │                                │
  │                               │◀── write to completed ─────────│
  │◀── onSnapshot ────────────────│   commands/completed/{id}      │
  │   UI updates                  │                                │
```

---

## Command Types

### Process Management

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `restart_process` | Kill and restart a process | `{process_name: string}` |
| `kill_process` | Terminate a process | `{process_name: string}` |
| `start_process` | Start a stopped process | `{process_name: string}` |
| `set_launch_mode` | Set launch mode (off/always/scheduled) | `{process_name, mode, schedules?}` |
| `capture_screenshot` | Capture desktop screenshot | `{monitor: number}` (0=all, 1=primary, etc.) |

### Configuration

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `update_config` | Update process configuration from cloud | `{processes: [...]}` |

### Software Deployment

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `install_software` | Download and install software | `{installer_url, installer_name, silent_flags, verify_path, deployment_id}` |
| `cancel_installation` | Cancel in-progress installation | `{deployment_id}` |

### Project Distribution

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `distribute_project` | Download and extract project files | `{project_url, project_name, extract_path, verify_files, distribution_id}` |

### System Commands

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `reboot_machine` | Reboot the machine | `{delay: number}` (seconds, default: 0) |
| `shutdown_machine` | Shut down the machine | `{delay: number}` (seconds, default: 0) |
| `update_owlette` | Self-update the agent | `{installer_url, version}` |
| `uninstall_owlette` | Uninstall the agent | `{}` |

### AI/Cortex Tools

| Command | Description | Data Payload |
|---------|-------------|--------------|
| `mcp_tool_call` | Execute a Cortex tool | `{tool_name, arguments, chat_id}` |

!!! info "Cortex tool reference"
    See the [Cortex Tools Reference](../reference/cortex-tools.md) for the complete list of 29 tools with parameters, tiers, and allowed commands.

---

## Command Document Structure

### Pending Command

Written to `sites/{siteId}/machines/{machineId}/commands/pending/{commandId}`:

```json
{
  "type": "restart_process",
  "process_name": "TouchDesigner",
  "timestamp": 1711234567890,
  "status": "pending"
}
```

### Completed Command

Moved to `sites/{siteId}/machines/{machineId}/commands/completed/{commandId}`:

```json
{
  "type": "restart_process",
  "result": "Process 'TouchDesigner' restarted successfully (PID: 12345)",
  "status": "completed",
  "completedAt": 1711234567900
}
```

### Failed Command

```json
{
  "type": "restart_process",
  "result": "Error: Process 'TouchDesigner' not found in configuration",
  "status": "failed",
  "completedAt": 1711234567900
}
```

---

## Command Polling (Dashboard)

When the dashboard sends a command with `wait: true`, it polls for completion:

1. Write command to pending queue
2. Poll `commands/completed/{commandId}` every 1.5 seconds
3. Timeout after 30-120 seconds (configurable)
4. Return result or timeout error

This is used by the Admin API (`/api/admin/commands/send`) and Cortex tool execution.

---

## Software Installation Flow

The `install_software` command triggers a multi-step process:

```
1. Download installer → %TEMP%\owlette_installers\
   Progress: downloading 0% → 100%

2. Execute installer with silent flags
   Progress: installing (no percentage — waiting for exit code)

3. Verify installation (if verify_path provided)
   Check: file exists at verify_path?

4. Cleanup temp file

5. Report result to Firestore
```

### Supported Installer Types

| Type | Silent Flag | Example |
|------|-------------|---------|
| **Inno Setup** | `/VERYSILENT /SUPPRESSMSGBOXES` | Owlette itself |
| **NSIS** | `/S` | Notepad++ |
| **MSI** | `msiexec /i installer.msi /qn` | Windows Installer packages |
| **Custom** | Varies | Any executable with silent flags |

---

## Project Distribution Flow

The `distribute_project` command:

```
1. Download ZIP → %TEMP%\owlette_projects\
   Progress: downloading 0% → 100%

2. Extract ZIP to target path
   Default: ~/Documents/OwletteProjects
   Progress: extracting 0% → 100%

3. Verify files (if verify_files provided)
   Check: each file/folder exists at extract path

4. Cleanup temp ZIP

5. Report result to Firestore
```

---

## System Command Details

### Reboot / Shutdown

Uses Windows `shutdown` command:

```python
# Reboot
os.system(f"shutdown /r /t {delay}")

# Shutdown
os.system(f"shutdown /s /t {delay}")
```

The agent logs the event to Firestore before executing.

### Self-Update

1. Download new installer to temp directory
2. Stop the Owlette service
3. Execute installer with `/VERYSILENT` flags
4. Installer upgrades in place, restarts service
5. New agent version starts and reconnects

### Uninstall

1. Run the Inno Setup uninstaller with `/VERYSILENT /FORCECLOSEAPPLICATIONS`
2. Service and all components are removed
3. Machine goes offline in dashboard
