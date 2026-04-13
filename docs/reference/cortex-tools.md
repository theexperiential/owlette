# cortex tools reference

Complete reference for all 43 tools available in Cortex, organized by tier.

---

## tier system

| tier | type | approval | count |
|------|------|----------|-------|
| **1** | Read-only | Auto-approved | 14 |
| **2** | Process & machine management | Auto-approved | 18 |
| **3** | Privileged | Requires user confirmation | 11 |

> **Server-side tools** (`get_site_logs`, `get_system_presets`, `deploy_software`) execute on the server and query Firestore directly — they do not route through the agent.

---

## tier 1: read-only tools

### get_site_logs

Get activity logs across all machines in the site. Useful for finding errors, crashes, and events across the fleet. **Server-side** — queries Firestore directly.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `level` | string | No | Filter: `error`, `warning`, `info` |
| `hours` | number | No | Look back this many hours (default: 24) |
| `limit` | number | No | Max logs to return (default: 50) |
| `action` | string | No | Filter by action type, e.g. `process_crash`, `agent_started` |

---

### get_system_info

Get comprehensive system information including hostname, OS (with correct Windows 10/11 detection), CPU model and usage, memory (used/total GB), disk (used/total GB), GPU model, driver version, VRAM (used/total GB), GPU load %, uptime, and agent version.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_process_list

Get all owlette-configured processes with their current status, PID, launch mode, executable path, file path / command arguments, working directory, and whether they are running.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_running_processes

Get all running OS processes with CPU and memory usage. Can filter by name.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `name_filter` | string | No | Filter by process name (case-insensitive) |
| `limit` | number | No | Max results (default: 50, max: 200) |

**Returns**: Processes sorted by memory usage with name, PID, CPU%, memory%.

---

### get_gpu_processes

Get per-process GPU memory (VRAM) usage via Windows Performance Counters — same data source as Task Manager. Shows dedicated and shared GPU memory per process, sorted by usage. Works cross-vendor (NVIDIA, AMD, Intel) and for all GPU APIs (DirectX, OpenGL, CUDA, Vulkan).

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_network_info

Get network interfaces with IP addresses, netmasks, and link status.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_disk_usage

Get disk usage for all drives including total, used, free space and percentage.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_event_logs

Get Windows event log entries from Application, System, or Security logs.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `log_name` | string | No | `Application`, `System`, or `Security` (default: Application) |
| `max_events` | number | No | Max entries (default: 20, max: 100) |
| `level` | string | No | Filter: `Error`, `Warning`, `Information` |

---

### get_service_status

Get the status and start type of a Windows service. Returned `start_type` disambiguates "stopped" states: `automatic` (should be running), `demand_start` (stopped-is-normal idle state, e.g. wuauserv/BITS), `disabled` (intentionally off).

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `service_name` | string | **Yes** | Windows service name to query |

---

### get_agent_config

Get the current owlette agent configuration (sensitive fields stripped).

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_agent_logs

Get recent owlette agent log entries.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `max_lines` | number | No | Max lines (default: 100, max: 500) |
| `level` | string | No | Filter: `ERROR`, `WARNING`, `INFO`, `DEBUG` |

---

### get_agent_health

Get agent health status including connection state and health probe results.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### get_system_presets

Get available software deployment presets managed by the site admin. Returns installer URLs, silent install flags, verification paths, and other deployment parameters for software like TouchDesigner, Unreal Engine, media players, etc. Use this before `deploy_software` to find the correct preset and parameters. **Server-side** — queries Firestore directly.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `software_name` | string | No | Filter by name (case-insensitive partial match), e.g. `TouchDesigner` |
| `category` | string | No | Filter by category, e.g. `Creative Software`, `Media Server` |

---

### check_pending_reboot

Detect whether a system reboot is currently pending (from Windows Update, Component Based Servicing, pending file rename operations, or SCCM client). Read-only diagnostic — use during incident investigations, after a suspected update, or when the machine is behaving unusually. The agent also emits a site-level auto-alert the first time it detects a pending reboot (idempotent via a flag file).

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns**: `pending` (bool), `reasons` (array), last update install time, next scheduled update run time (if available).

---

## tier 2: process & machine management tools

These execute immediately without user confirmation. Owlette-configured process tools (`restart_process`, `kill_process`, `start_process`, `set_launch_mode`) wrap existing commands; the rest are purpose-built with validated parameters and narrower blast radius than raw shell scripts.

### restart_process

Restart an owlette-configured process by name.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### kill_process

Kill/stop a running owlette-configured process.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### start_process

Start a stopped owlette-configured process.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `process_name` | string | **Yes** | Must match a configured process name |

---

### set_launch_mode

Set the launch mode for a process.

| parameter | type | required | description |
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

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `monitor` | number | No | `0` = all monitors combined (default), `1` = primary, `2` = second, etc. |

---

### manage_process

Kill, suspend, or resume OS processes by name pattern. Works on **any** process, not just Owlette-managed ones. Safer than `run_command` + `taskkill`: validated params, no shell, refuses to touch critical system processes (lsass, winlogon, csrss, etc.) via an internal blocklist.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `name_pattern` | string | **Yes** | Process name with `.exe` or glob (e.g. `chrome.exe`, `FreeFileSync*`) |
| `action` | string | **Yes** | `kill`, `suspend`, or `resume` |
| `match_exact` | boolean | No | Exact match (default `true`) vs glob via fnmatch |
| `force` | boolean | No | For `kill`: force immediately (default `true`), else graceful first |

---

### manage_windows_service

Full `services.msc` parity — start, stop, restart, pause/continue, set startup type, configure failure recovery, or get full service details in one call. Use `set_recovery` to configure auto-restart on crash (critical for unattended media installations). Use `get_details` to query status, startup type, binary path, dependencies, and recovery config at once.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `service_name` | string | **Yes** | Service name (not display name) |
| `action` | string | **Yes** | `start`, `stop`, `restart`, `pause`, `continue`, `set_startup`, `set_recovery`, `get_details` |
| `startup_type` | string | For `set_startup` | `auto`, `auto_delayed`, `manual`, `disabled` |
| `first_failure` | string | For `set_recovery` | `restart`, `run_program`, `reboot`, `none` |
| `second_failure` | string | For `set_recovery` | Same options as `first_failure` |
| `subsequent_failures` | string | For `set_recovery` | Action on third and later failures |
| `restart_delay_ms` | number | No | Delay before recovery action (default: 60000) |
| `reset_counter_days` | number | No | Days with no failures before counter resets (default: 1) |
| `reboot_message` | string | No | Broadcast message if action is `reboot` |
| `run_program_path` | string | If any action is `run_program` | Program to run on failure |

---

### configure_gpu_tdr

Configure Windows GPU Timeout Detection and Recovery. Writes `TdrDelay` (and optionally `TdrDdiDelay`) to the registry. Critical for TouchDesigner / Unreal / Unity installations with heavy shader work — the default 2-second timeout causes silent crashes on complex GPU operations. A reboot is required for changes to take effect.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `timeout_seconds` | number | **Yes** | `TdrDelay` in seconds (2-300). Default Windows value is 2; heavy creative workloads usually need 10-60 |
| `ddi_timeout_seconds` | number | No | Optional `TdrDdiDelay` in seconds (2-300). Max time GPU can spend in Present/Draw calls |

---

### manage_windows_update

Pause, resume, or schedule Windows Update. Pause before live events; use `set_active_hours` to block auto-reboot during quiet hours; `set_scheduled_install` for exact install timing; `set_feature_deferral` / `set_quality_deferral` to delay rollouts. Windows Update is the #1 threat to unattended 24/7 installations.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | `get_status`, `pause`, `resume`, `set_active_hours`, `set_scheduled_install`, `set_restart_deadline`, `set_feature_deferral`, `set_quality_deferral` |
| `pause_days` | number | For `pause` | Days to pause (1-35) |
| `start_hour` / `end_hour` | number | For `set_active_hours` | Hours (0-23) |
| `day_of_week` | number | For `set_scheduled_install` | `0` = every day, `1`-`7` = Sun–Sat |
| `hour` | number | For `set_scheduled_install` | Hour of day (0-23) |
| `deadline_days` | number | For `set_restart_deadline` | Days before force reboot (2-14) |
| `days` | number | For deferral actions | Feature (0-365) or quality (0-30) deferral days |

---

### manage_notifications

Control Windows toast notifications and Focus Assist. Essential for kiosks and video walls where a surprise "Updates are ready" toast would interrupt an exhibit. Use `disable_all_toasts` to fully silence the system, `enable_focus_assist` with `alarms_only` for total silence, or `disable_for_app` to silence a specific app.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | `get_status`, `disable_all_toasts`, `enable_focus_assist`, `disable_focus_assist`, `disable_for_app` |
| `app_name` | string | For `disable_for_app` | App identifier (e.g. `Microsoft.WindowsStore`, `MSTeams`) |
| `focus_mode` | string | For `enable_focus_assist` | `priority_only` or `alarms_only` |

---

### configure_power_plan

Set Windows power plan and disable sleep/hibernate/screen blanking. Required for any 24/7 unattended installation — default power settings will sleep the machine, blank the screen, or hibernate, all of which break live deployments.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `plan` | string | No | `high_performance`, `balanced`, or `ultimate_performance` (omit to keep current) |
| `disable_sleep` | boolean | No | Set standby timeout to Never on both AC and battery |
| `disable_hibernate` | boolean | No | Disable hibernation (removes `hiberfil.sys`) |
| `disable_screen_blanking` | boolean | No | Disable monitor timeout |

---

### manage_scheduled_task

Full Task Scheduler parity — list, enable, disable, delete, `run_now`, stop, create new tasks, get details, and get run history. Use `create` for weekly memory-flush reboots, boot-time media app launches, or event-triggered restarts.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | `list`, `enable`, `disable`, `delete`, `run_now`, `stop`, `create`, `get_details`, `get_history` |
| `task_name` | string | For non-list actions | Task name; can include folder path (e.g. `\Folder\TaskName`) |
| `name_filter` | string | For `list` | Substring filter |
| `description` | string | No | For `create`: human-readable description |
| `trigger` | object | For `create` | `{type: "boot"\|"logon"\|"once"\|"daily"\|"weekly"\|"on_event"\|"on_idle", ...}`. Additional fields depend on type |
| `task_action` | object | For `create` | `{type: "run_program", program, arguments?, working_directory?}` |
| `principal` | object | For `create` | `{run_as: SYSTEM\|LOCAL_SERVICE\|NETWORK_SERVICE\|current_user, run_level: highest\|limited}` |
| `settings` | object | No | `{start_when_available, execution_time_limit_minutes, restart_count, restart_interval_minutes, run_only_if_network_available, allow_start_on_batteries, hidden, multiple_instances, delete_expired_task_after_days}` |

---

### network_reset

Flush DNS, renew IP lease, restart a network adapter, or reset the winsock stack. Common fix for NDI dropouts, Firebase connectivity loss, DNS resolution issues at venue networks. `reset_winsock` requires a reboot to fully take effect.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | `flush_dns`, `renew_ip`, `restart_adapter`, `reset_winsock` |
| `adapter_name` | string | For `restart_adapter` | Adapter name (e.g. `Ethernet`, `Wi-Fi`) |

---

### registry_operation

Read, write, or delete Windows registry values. Restricted to an allowlist of safe registry paths (Winlogon, GraphicsDrivers, WindowsUpdate, Notifications, Power, Services, etc.) — system hives like SAM, SECURITY, and Cryptography are blocked.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | `read`, `write`, `delete` |
| `hive` | string | **Yes** | `HKLM` (machine) or `HKCU` (current user) |
| `key_path` | string | **Yes** | Key path under hive (must match an allowed prefix) |
| `value_name` | string | For `write`/`delete` | Omit for `read` to enumerate all values in the key |
| `value_data` | string | For `write` | Data to write (dword as `"8"`, binary as hex string, etc.) |
| `value_type` | string | For `write` | `string`, `dword`, `binary`, `expand_string`, `multi_string` |

---

### clean_disk_space

Clean temp files, Windows temp, prefetch cache, recycle bin, or Owlette logs with an age filter. Use `dry_run=true` to preview what would be deleted.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `target` | string | **Yes** | `temp`, `windows_temp`, `prefetch`, `recycle_bin`, `owlette_logs` |
| `older_than_days` | number | No | Only delete files older than N days (default: 7). Ignored for `recycle_bin` |
| `dry_run` | boolean | No | Return counts/sizes without deleting (default: false) |

---

### get_event_logs_filtered

Fast filtered event log query via `Get-WinEvent -FilterHashtable`. Orders of magnitude faster than `get_event_logs` when searching for specific crashes, process sources, or event IDs.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `log_name` | string | **Yes** | `Application`, `System`, `Security`, `Setup` |
| `process_name` | string | No | Filter by provider/source name |
| `event_id` | number | No | Specific event ID (e.g. 41 for unexpected shutdown, 1000 for app crash) |
| `hours_back` | number | No | Look back this many hours (1-168, default: 24) |
| `level` | string | No | `Critical`, `Error`, `Warning`, `Information`, `Verbose` |
| `max_events` | number | No | Max events (1-200, default: 50) |

---

### manage_windows_feature

Add, remove, or list Windows Optional Features (DISM, e.g. `NetFx3`, `OpenSSH-Server`), Windows Capabilities (FoD, e.g. `OpenSSH.Client`), or AppX Packages (Store apps like OneDrive, Xbox Game Bar, Cortana, Teams). Critical features for Owlette itself are blocklisted and cannot be disabled. AppX install is not supported.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `type` | string | **Yes** | `optional_feature`, `capability`, `appx_package` |
| `action` | string | **Yes** | `list`, `install`, `remove` |
| `name` | string | For `install`/`remove` | Feature/capability/package name |
| `all_users` | boolean | No | For `appx_package` remove: also remove provisioning package (default: false) |
| `name_filter` | string | For `list` | Substring filter |

---

### show_notification

Display an on-screen message on the remote machine — useful when a technician is physically nearby. Toast style is a subtle corner notification; modal style uses `msg.exe` to block the screen briefly. Opposite of `manage_notifications`, which suppresses notifications.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `message` | string | **Yes** | Notification body |
| `title` | string | No | Notification title |
| `style` | string | No | `toast` (default, subtle corner) or `modal` (blocking `msg.exe` box) |
| `duration_seconds` | number | No | For `modal`: how long the box stays up (default: 5) |

---

## tier 3: privileged tools

These require explicit user confirmation before execution.

### run_command

Execute a shell command on the remote machine.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `command` | string | **Yes** | Must start with an allowed command |
| `user_session` | boolean | No | Run in the logged-in user's desktop session (needed for GUI/display access) |

**Returns**: stdout, stderr, exit code.

**Allowed commands** (first word must be one of):

`ipconfig`, `systeminfo`, `tasklist`, `netstat`, `ping`, `tracert`, `nslookup`, `hostname`, `whoami`, `wmic`, `sc`, `net`, `route`, `arp`, `getmac`, `vol`, `ver`, `set`, `type`, `dir`, `where`, `certutil`, `sfc`, `dism`, `chkdsk`, `nvidia-smi`

---

### run_powershell

Execute a PowerShell command on the remote machine.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `script` | string | **Yes** | First cmdlet must be in the allow-list |
| `user_session` | boolean | No | Run in the logged-in user's desktop session |

**Returns**: stdout, stderr, exit code.

**Allowed cmdlets** (first cmdlet must be one of):

`Get-Process`, `Get-Service`, `Get-EventLog`, `Get-WmiObject`, `Get-CimInstance`, `Get-NetAdapter`, `Get-NetIPAddress`, `Get-Volume`, `Get-Disk`, `Get-PSDrive`, `Get-ChildItem`, `Get-Content`, `Get-ItemProperty`, `Test-Connection`, `Test-NetConnection`, `Resolve-DnsName`, `Get-HotFix`, `Get-ComputerInfo`

---

### run_python

Execute Python code on the remote machine in the user's desktop session.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `code` | string | **Yes** | Python code to execute |

**Sandboxed execution** (since v2.6.5). When invoked via this tool, code runs with:

- **Restricted `__builtins__`** — `eval`, `exec`, `compile`, `globals`, `locals`, `breakpoint`, `input`, `exit`, `quit` are all removed. `open`, `print`, `getattr`/`setattr`, and common types/exceptions remain available.
- **Gated imports** — only a curated subset of the standard library is importable: `math`, `json`, `re`, `datetime`, `time`, `random`, `collections`, `itertools`, `functools`, `operator`, `string`, `textwrap`, `decimal`, `fractions`, `statistics`, `copy`, `pprint`, `base64`, `hashlib`, `hmac`, `struct`, `io`, `csv`, `pathlib`, `typing`, `dataclasses`, `enum`, `abc`. Dangerous modules — `os`, `subprocess`, `shutil`, `ctypes`, `socket`, and third-party packages like `psutil` or `mss` — raise `ImportError` with guidance to use `execute_script` or `run_command` instead.
- **No filesystem access beyond `output_dir`** — the code can `open()` files it writes into the provided `output_dir` variable, but cannot reach the rest of the filesystem without going through a gated import.

The LLM **cannot** escape this sandbox. Internal first-party callers (e.g. the agent's own screenshot capture path in `agent/src/session_exec.py`) pass `trusted=True`, which restores full builtins and unrestricted imports; that flag is not reachable from the LLM-exposed tool schema.

**Returns**: stdout from `print()`, plus any files written to `output_dir`.

---

### read_file

Read the contents of a file on the remote machine.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path (max 100KB) |

---

### write_file

Write content to a file on the remote machine.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute file path |
| `content` | string | **Yes** | Content to write |

---

### list_directory

List the contents of a directory with file sizes and modification dates.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `path` | string | **Yes** | Absolute directory path |

---

### execute_script

Execute a PowerShell script on the remote machine with **no command restrictions**. Use for software installs, diagnostics, stress tests, service management, registry edits, or any other admin task. For most routine sysadmin scenarios, prefer a purpose-built Tier 2 tool (e.g. `manage_windows_service`, `registry_operation`, `clean_disk_space`) — `execute_script` is the escape hatch when no purpose-built tool fits.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `script` | string | **Yes** | PowerShell script to execute (can be multi-line) |
| `timeout_seconds` | number | No | Timeout in seconds (default: 120) — set higher for long operations like installs |
| `working_directory` | string | No | Optional working directory for script execution |

**Returns**: stdout, stderr, exit code.

---

### deploy_software

Deploy and install software on the remote machine using the full deployment pipeline: download installer, run silent install, verify installation, and track progress. Creates a tracked deployment visible on the Deployments page. **Server-side** — orchestrated by the server, not the agent directly.

**Requires user confirmation before execution.** Cortex will summarize the deployment plan (software, version, install path, parallel install status, processes to close) and wait for explicit approval before proceeding.

| parameter | type | required | description |
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

Reboot the remote machine with a 30-second countdown delay. Can be cancelled from the dashboard or via `cancel_reboot` within the countdown window.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### shutdown_machine

Shut down the remote machine with a 30-second countdown delay. The machine will NOT automatically restart.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

### cancel_reboot

Cancel a pending reboot or shutdown. Must be called within the 30-second countdown window.

| parameter | type | required | description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

---

## security model

### tool execution flow

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

### command allowlists

Tier 3 tools (`run_command`, `run_powershell`) enforce allowlists on the **agent side**. Even if a command is sent via Firestore, the agent rejects it if the first command/cmdlet isn't in the allowlist. `run_python` similarly enforces its sandbox on the agent side — the LLM cannot override the import gate or restore blocked builtins.

### tier 2 blocklists

Tier 2 tools enforce per-tool blocklists to prevent self-inflicted outages:

- `manage_process` — critical system processes (lsass, winlogon, csrss, etc.) cannot be killed
- `registry_operation` — SAM, SECURITY, and Cryptography hives are unreachable; only an allowlist of safe key prefixes is permitted
- `manage_windows_feature` — core Windows features Owlette depends on (NetFx4, WMI-\*, PowerShell\*) cannot be removed

All Tier 2 tools emit structured `[MCP-AUDIT]` log entries for each invocation.

### agent-side limits

- **Subprocess timeout**: 25 seconds (default; overridable per-tool where applicable)
- **Max output size**: 50KB
- **Screenshot max size**: 10MB
