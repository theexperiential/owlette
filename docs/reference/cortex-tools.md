# Cortex Tools Reference

Complete reference for all 19 MCP tools available in Cortex, organized by tier.

---

## Tier System

| Tier | Type | Approval | Count |
|------|------|----------|-------|
| **1** | Read-only | Auto-approved | 10 |
| **2** | Process management | Auto-approved | 4 |
| **3** | Privileged | Requires user confirmation | 5 |

---

## Tier 1: Read-Only Tools

### get_system_info

Get comprehensive system information.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: CPU usage, memory usage, disk usage, GPU usage, hostname, OS version, uptime, agent version, CPU model.

---

### get_process_list

Get all Owlette-configured processes with their status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: Array of processes with name, status (RUNNING/STOPPED/etc.), PID, autolaunch setting.

---

### get_running_processes

Get all running OS processes with resource usage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name_filter` | string | No | Filter by process name (case-insensitive) |
| `limit` | number | No | Max results (default: 50, max: 200) |

**Returns**: Processes sorted by memory usage with name, PID, CPU%, memory%.

---

### get_network_info

Get network interface information.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: Network interfaces with IP addresses, netmasks, link status.

---

### get_disk_usage

Get disk usage for all drives.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: Per-drive total, used, free space and usage percentage.

---

### get_event_logs

Get Windows event log entries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `log_name` | string | No | `Application`, `System`, or `Security` (default: Application) |
| `max_events` | number | No | Max entries (default: 20, max: 100) |
| `level` | string | No | Filter: `Error`, `Warning`, `Information` |

**Returns**: Event log entries with timestamp, source, level, message.

---

### get_service_status

Get the status of a Windows service.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `service_name` | string | **Yes** | Windows service name to query |

**Returns**: Service status (running, stopped, paused, etc.).

---

### get_agent_config

Get the current Owlette agent configuration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: Agent configuration with sensitive fields (tokens, keys) stripped.

---

### get_agent_logs

Get recent Owlette agent log entries.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `max_lines` | number | No | Max lines (default: 100, max: 500) |
| `level` | string | No | Filter: `ERROR`, `WARNING`, `INFO`, `DEBUG` |

**Returns**: Log lines with timestamps and levels.

---

### get_agent_health

Get agent health status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: Connection state, health probe results, Firebase status.

---

## Tier 2: Process Management Tools

These wrap existing Owlette commands and execute immediately.

### restart_process

Restart an Owlette-configured process.

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

### toggle_autolaunch

Toggle the autolaunch setting for a process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

## Tier 3: Privileged Tools

These require explicit user confirmation before execution.

### run_command

Execute a shell command on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | **Yes** | Must start with an allowed command |

**Returns**: stdout, stderr, exit code.

**Allowed commands** (first word must be one of):

`ipconfig`, `systeminfo`, `tasklist`, `netstat`, `ping`, `tracert`, `nslookup`, `hostname`, `whoami`, `wmic`, `sc`, `net`, `route`, `arp`, `getmac`, `vol`, `ver`, `set`, `type`, `dir`, `where`, `certutil`, `sfc`, `dism`, `chkdsk`

---

### run_powershell

Execute a PowerShell command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | **Yes** | First cmdlet must be in the allow-list |

**Returns**: stdout, stderr, exit code.

**Allowed cmdlets** (first cmdlet must be one of):

`Get-Process`, `Get-Service`, `Get-EventLog`, `Get-WmiObject`, `Get-CimInstance`, `Get-NetAdapter`, `Get-NetIPAddress`, `Get-Volume`, `Get-Disk`, `Get-PSDrive`, `Get-ChildItem`, `Get-Content`, `Get-ItemProperty`, `Test-Connection`, `Test-NetConnection`, `Resolve-DnsName`, `Get-HotFix`, `Get-ComputerInfo`

---

### read_file

Read a file on the remote machine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path (max 100KB) |

**Returns**: File contents as text.

---

### write_file

Write content to a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path |
| `content` | string | **Yes** | Content to write |

**Returns**: Success or error message.

---

### list_directory

List directory contents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute directory path |

**Returns**: Files and folders with sizes and modification dates.

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
