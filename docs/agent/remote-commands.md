# remote commands

The agent listens for commands from the web dashboard via Firestore. Commands are written to a pending queue, executed by the agent, and results are written to a completed queue.

---

## command lifecycle

```
Dashboard                      Firestore                         Agent
  │                               │                                │
  │── write to pending ──────────▶│                                │
  │   commands/pending/{id}       │── listener detects ───────────▶│
  │                               │                                │── execute
  │                               │                                │
  │                               │◀── write to completed ─────────│
  │◀── onSnapshot ──────────────────│   commands/completed/{id}      │
  │   UI updates                  │                                │
```

---

## command types

### process management

| command | description | data payload |
|---------|-------------|--------------|
| `restart_process` | Kill and restart a process | `{process_name: string}` |
| `kill_process` | Terminate a process | `{process_name: string}` |
| `start_process` | Start a stopped process | `{process_name: string}` |
| `set_launch_mode` | Set launch mode (off/always/scheduled) | `{process_name, mode, schedules?}` |
| `capture_screenshot` | Capture desktop screenshot | `{monitor: number}` (0=all, 1=primary, etc.) |

### configuration

| command | description | data payload |
|---------|-------------|--------------|
| `update_config` | Update process configuration from cloud | `{processes: [...]}` |

### software deployment

| command | description | data payload |
|---------|-------------|--------------|
| `install_software` | Download and install software | `{installer_url, installer_name, silent_flags, verify_path, deployment_id}` |
| `cancel_installation` | Cancel in-progress installation | `{deployment_id}` |

### project distribution

| command | description | data payload |
|---------|-------------|--------------|
| `distribute_project` | Download and extract project files | `{project_url, project_name, extract_path, verify_files, distribution_id}` |

### system commands

| command | description | data payload |
|---------|-------------|--------------|
| `reboot_machine` | Reboot the machine | `{delay: number}` (seconds, default: 0) |
| `shutdown_machine` | Shut down the machine | `{delay: number}` (seconds, default: 0) |
| `update_owlette` | Self-update the agent | `{installer_url, version}` |
| `uninstall_owlette` | Uninstall the agent | `{}` |

### ai/cortex tools

| command | description | data payload |
|---------|-------------|--------------|
| `mcp_tool_call` | Execute a Cortex tool | `{tool_name, arguments, chat_id}` |

!!! info "Cortex tool reference"
    See the [Cortex Tools Reference](../reference/cortex-tools.md) for the complete list of 29 tools with parameters, tiers, and allowed commands.

---

## command document structure

### pending command

Written to `sites/{siteId}/machines/{machineId}/commands/pending/{commandId}`:

```json
{
  "type": "restart_process",
  "process_name": "TouchDesigner",
  "timestamp": 1711234567890,
  "status": "pending"
}
```

### completed command

Moved to `sites/{siteId}/machines/{machineId}/commands/completed/{commandId}`:

```json
{
  "type": "restart_process",
  "result": "Process 'TouchDesigner' restarted successfully (PID: 12345)",
  "status": "completed",
  "completedAt": 1711234567900
}
```

### failed command

```json
{
  "type": "restart_process",
  "result": "Error: Process 'TouchDesigner' not found in configuration",
  "status": "failed",
  "completedAt": 1711234567900
}
```

---

## command polling (dashboard)

When the dashboard sends a command with `wait: true`, it polls for completion:

1. Write command to pending queue
2. Poll `commands/completed/{commandId}` every 1.5 seconds
3. Timeout after 30-120 seconds (configurable)
4. Return result or timeout error

This is used by the Admin API (`/api/admin/commands/send`) and Cortex tool execution.

---

## software installation flow

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

### supported installer types

| type | silent flag | example |
|------|-------------|---------|
| **Inno Setup** | `/VERYSILENT /SUPPRESSMSGBOXES` | owlette itself |
| **NSIS** | `/S` | Notepad++ |
| **MSI** | `msiexec /i installer.msi /qn` | Windows Installer packages |
| **Custom** | Varies | Any executable with silent flags |

---

## project distribution flow

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

## system command details

### reboot / shutdown

Uses Windows `shutdown` command:

```python
# Reboot
os.system(f"shutdown /r /t {delay}")

# Shutdown
os.system(f"shutdown /s /t {delay}")
```

The agent logs the event to Firestore before executing.

### self-update

1. Download new installer to temp directory
2. Stop the owlette service
3. Execute installer with `/VERYSILENT` flags
4. Installer upgrades in place, restarts service
5. New agent version starts and reconnects

### uninstall

1. Run the Inno Setup uninstaller with `/VERYSILENT /FORCECLOSEAPPLICATIONS`
2. Service and all components are removed
3. Machine goes offline in dashboard
