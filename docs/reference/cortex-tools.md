# Cortex Tools Reference

Complete reference for all 24 tools available in Cortex, organized by tier.

---

## Tier System

| Tier | Type | Approval | Count |
|------|------|----------|-------|
| **1** | Read-only | Auto-approved | 10 |
| **2** | Process & machine management | Auto-approved | 5 |
| **3** | Privileged | Requires user confirmation | 9 |

---

## Tier 1: Read-Only Tools

### get_system_info

Get comprehensive system information including hostname, OS (with correct Windows 10/11 detection), CPU model and usage, memory (used/total GB), disk (used/total GB), GPU model, driver version, VRAM (used/total GB), GPU load %, uptime, and agent version.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_process_list

Get all Owlette-configured processes with their current status, PID, launch mode, and whether they are running.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_running_processes

Get all running OS processes with CPU and memory usage. Can filter by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name_filter` | string | No | Filter by process name (case-insensitive) |
| `limit` | number | No | Max results (default: 50, max: 200) |

**Returns**: Processes sorted by memory usage with name, PID, CPU%, memory%.

---

### get_network_info

Get network interfaces with IP addresses, netmasks, and link status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_disk_usage

Get disk usage for all drives including total, used, free space and percentage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_event_logs

Get Windows event log entries from Application, System, or Security logs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `log_name` | string | No | `Application`, `System`, or `Security` (default: Application) |
| `max_events` | number | No | Max entries (default: 20, max: 100) |
| `level` | string | No | Filter: `Error`, `Warning`, `Information` |

---

### get_service_status

Get the status of a Windows service by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `service_name` | string | **Yes** | Windows service name to query |

---

### get_agent_config

Get the current Owlette agent configuration (sensitive fields stripped).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_agent_logs

Get recent Owlette agent log entries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `max_lines` | number | No | Max lines (default: 100, max: 500) |
| `level` | string | No | Filter: `ERROR`, `WARNING`, `INFO`, `DEBUG` |

---

### get_agent_health

Get agent health status including connection state and health probe results.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

## Tier 2: Process & Machine Management Tools

These wrap existing Owlette commands and execute immediately without user confirmation.

### restart_process

Restart an Owlette-configured process by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### kill_process

Kill/stop a running process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### start_process

Start a stopped process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### set_launch_mode

Set the launch mode for a process. Replaces the old `toggle_autolaunch` with three modes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |
| `mode` | string | **Yes** | `off` (not managed), `always` (24/7 with crash recovery), or `scheduled` |
| `schedules` | array | When `mode=scheduled` | Schedule blocks with `days` and time `ranges` |

**Schedule block format:**

```json
{
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "ranges": [
    { "start": "09:00", "stop": "18:00" }
  ]
}
```

---

### capture_screenshot

Capture a screenshot of the remote machine's desktop.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `monitor` | number | No | `0` = all monitors combined (default), `1` = primary, `2` = second, etc. |

**Returns**: URL to the captured image in Firebase Storage.

---

## Tier 3: Privileged Tools

These require explicit user confirmation before execution.

### run_command

Execute a shell command on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | **Yes** | Must start with an allowed command |
| `user_session` | boolean | No | Run in the logged-in user's desktop session (needed for GUI/display access) |

**Returns**: stdout, stderr, exit code.

**Allowed commands** (first word must be one of):

`ipconfig`, `systeminfo`, `tasklist`, `netstat`, `ping`, `tracert`, `nslookup`, `hostname`, `whoami`, `wmic`, `sc`, `net`, `route`, `arp`, `getmac`, `vol`, `ver`, `set`, `type`, `dir`, `where`, `certutil`, `sfc`, `dism`, `chkdsk`, `nvidia-smi`

---

### run_powershell

Execute a PowerShell command on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | **Yes** | First cmdlet must be in the allow-list |
| `user_session` | boolean | No | Run in the logged-in user's desktop session |

**Returns**: stdout, stderr, exit code.

**Allowed cmdlets** (first cmdlet must be one of):

`Get-Process`, `Get-Service`, `Get-EventLog`, `Get-WmiObject`, `Get-CimInstance`, `Get-NetAdapter`, `Get-NetIPAddress`, `Get-Volume`, `Get-Disk`, `Get-PSDrive`, `Get-ChildItem`, `Get-Content`, `Get-ItemProperty`, `Test-Connection`, `Test-NetConnection`, `Resolve-DnsName`, `Get-HotFix`, `Get-ComputerInfo`

---

### run_python

Execute Python code on the remote machine in the user's desktop session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | **Yes** | Python code to execute |

The code runs in the agent's Python environment with access to installed packages (`mss`, `psutil`, etc.). Use the `output_dir` variable to write output files. Use `print()` for text output.

**Returns**: stdout output and any files written to `output_dir`.

---

### read_file

Read the contents of a file on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path (max 100KB) |

---

### write_file

Write content to a file on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path |
| `content` | string | **Yes** | Content to write |

---

### list_directory

List the contents of a directory with file sizes and modification dates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute directory path |

---

### reboot_machine

Reboot the remote machine with a 30-second countdown delay. Can be cancelled within the countdown window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### shutdown_machine

Shut down the remote machine with a 30-second countdown delay. The machine will NOT automatically restart.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### cancel_reboot

Cancel a pending reboot or shutdown. Must be called within the 30-second countdown window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

## Security Model

### Tool Execution Flow

```
LLM decides to call a tool
    │
    ├── Tier 1/2: Execute immediately
    │     │
    │     ├── Create mcp_tool_call command in Firestore
    │     ├── Agent receives and executes
    │     ├── Agent writes result to completed queue
    │     └── API polls for result (1.5s intervals, 30s timeout)
    │
    └── Tier 3: Pause for confirmation
          │
          ├── Dashboard shows confirmation dialog
          ├── User clicks Confirm → execute as above
          └── User clicks Deny → tool returns "denied by user"
```

### Command Allowlists

Tier 3 tools (`run_command`, `run_powershell`) enforce allowlists on the **agent side**. Even if a command is sent via Firestore, the agent rejects it if the first command/cmdlet isn't in the allowlist. This prevents LLM prompt injection from executing arbitrary commands.

### Agent-Side Limits

- **Subprocess timeout**: 25 seconds
- **Max output size**: 50KB
- **Screenshot max size**: 10MB
