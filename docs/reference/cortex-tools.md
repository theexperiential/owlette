# Cortex Tools Reference

Complete reference for all 29 tools available in Cortex, organized by tier.

---

## Tier System

| Tier | Type | Approval | Count |
|------|------|----------|-------|
| **1** | Read-only | Auto-approved | 13 |
| **2** | Process & machine management | Auto-approved | 5 |
| **3** | Privileged | Requires user confirmation | 11 |

> **Server-side tools** (`get_site_logs`, `get_system_presets`, `deploy_software`) execute on the server and query Firestore directly — they do not route through the agent.

---

## Tier 1: Read-Only Tools

### get_site_logs

Get activity logs across all machines in the site. Useful for finding errors, crashes, and events across the fleet. **Server-side** — queries Firestore directly.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | No | Filter: `error`, `warning`, `info` |
| `hours` | number | No | Look back this many hours (default: 24) |
| `limit` | number | No | Max logs to return (default: 50) |
| `action` | string | No | Filter by action type, e.g. `process_crash`, `agent_started` |

---

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

### get_gpu_processes

Get per-process GPU memory (VRAM) usage via Windows Performance Counters — same data source as Task Manager. Shows dedicated and shared GPU memory per process, sorted by usage. Works cross-vendor (NVIDIA, AMD, Intel) and for all GPU APIs (DirectX, OpenGL, CUDA, Vulkan).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

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

### get_system_presets

Get available software deployment presets managed by the site admin. Returns installer URLs, silent install flags, verification paths, and other deployment parameters for software like TouchDesigner, Unreal Engine, media players, etc. Use this before `deploy_software` to find the correct preset and parameters. **Server-side** — queries Firestore directly.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `software_name` | string | No | Filter by name (case-insensitive partial match), e.g. `TouchDesigner` |
| `category` | string | No | Filter by category, e.g. `Creative Software`, `Media Server` |

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

Capture a screenshot of the remote machine's desktop. Returns the image for visual analysis — use to diagnose display issues, verify process state, or see what's currently on screen.

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

### execute_script

Execute a PowerShell script on the remote machine with no command restrictions. Use for software installs, diagnostics, stress tests, service management, registry edits, or any other admin task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | **Yes** | PowerShell script to execute (can be multi-line) |
| `timeout_seconds` | number | No | Timeout in seconds (default: 120) — set higher for long operations like installs |
| `working_directory` | string | No | Optional working directory for script execution |

**Returns**: stdout, stderr, exit code.

---

### deploy_software

Deploy and install software on the remote machine using the full deployment pipeline: download installer, run silent install, verify installation, and track progress. Creates a tracked deployment visible on the Deployments page. **Server-side** — orchestrated by the server, not the agent directly.

**Requires user confirmation before execution.** Cortex will summarize the deployment plan (software, version, install path, parallel install status, processes to close) and wait for explicit approval before proceeding.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `software_name` | string | **Yes** | Software name, e.g. `TouchDesigner`, `Unreal Engine` |
| `version` | string | No | Version string, e.g. `2025.32280`. Required for version-specific software |
| `preset_id` | string | No | System preset ID from `get_system_presets` |
| `installer_url` | string | No | Direct HTTPS installer URL (overrides preset URL) |
| `installer_name` | string | No | Installer filename (auto-derived from URL if omitted) |
| `silent_flags` | string | No | Silent install flags (overrides preset value) |
| `close_processes` | array | No | Process names to terminate before install, e.g. `["TouchDesigner.exe"]` |
| `parallel_install` | boolean | No | Install alongside existing versions (auto-enabled for TouchDesigner) |
| `timeout_minutes` | number | No | Max installation time in minutes (default: 40) |

**TouchDesigner specifics:** Download URL is auto-constructed from version number. `parallel_install` is automatically enabled to prevent the installer from removing existing builds. Use the full installer, not the WebInstaller.

**Silent flag formats by installer type:**
- Inno Setup: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="path"`
- NSIS: `/S /D=path`
- MSI: `/quiet /norestart INSTALLDIR="path"`

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
