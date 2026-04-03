# agent commands reference

Complete reference for all command types the agent accepts via Firestore.

---

## command lifecycle

```
1. Dashboard/API writes to:
   sites/{siteId}/machines/{machineId}/commands/pending/{commandId}

2. Agent listener detects new document

3. Agent executes the command

4. Agent writes result to:
   sites/{siteId}/machines/{machineId}/commands/completed/{commandId}

5. Dashboard listener sees completion, updates UI
```

---

## command document schema

### pending

```json
{
  "type": "command_type",
  "timestamp": 1711234567890,
  "status": "pending",
  ...command-specific fields
}
```

### completed (success)

```json
{
  "type": "command_type",
  "result": "Human-readable result message",
  "status": "completed",
  "completedAt": 1711234567900
}
```

### completed (failure)

```json
{
  "type": "command_type",
  "result": "Error: description of what went wrong",
  "status": "failed",
  "completedAt": 1711234567900
}
```

---

## process commands

### restart_process

Kill and relaunch a configured process.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"restart_process"` | |
| `process_name` | string | Must match a configured process name |

---

### kill_process

Terminate a running process.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"kill_process"` | |
| `process_name` | string | Must match a configured process name |

---

### start_process

Start a stopped process (same as restart for stopped processes).

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"start_process"` | |
| `process_name` | string | Must match a configured process name |

---

### set_launch_mode

Set the launch mode for a process: off, always, or scheduled.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"set_launch_mode"` | |
| `process_name` | string | Must match a configured process name |
| `mode` | string | `"off"`, `"always"`, or `"scheduled"` |
| `schedules` | array | Schedule blocks (required when mode is `"scheduled"`) |

---

### capture_screenshot

Capture a screenshot of the machine's desktop.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"capture_screenshot"` | |
| `monitor` | number | `0` = all monitors (default), `1` = primary, `2` = second, etc. |

---

## configuration commands

### update_config

Update process configuration from Firestore.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"update_config"` | |
| `processes` | array | New process configuration array |

---

## deployment commands

### install_software

Download and silently install software.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"install_software"` | |
| `installer_url` | string | Direct HTTPS download URL |
| `installer_name` | string | Filename (e.g., "setup.exe") |
| `silent_flags` | string | Installation flags (e.g., "/VERYSILENT") |
| `verify_path` | string | Path to check after installation (optional) |
| `deployment_id` | string | Links to deployments collection |
| `sha256_checksum` | string | Expected SHA256 hash for download verification (optional) |
| `timeout_seconds` | number | Max time to wait for installation in seconds (default: 2400 = 40 min) |

The agent downloads the installer to `%TEMP%\owlette_installers\`, optionally verifies the checksum, executes with the provided flags, and reports progress (`downloading` → `installing` → `completed`/`failed`). If `verify_path` is set, the agent confirms the file exists after installation.

---

### cancel_installation

Cancel an in-progress installation. Terminates the installer process tree (parent + children) and cleans up the temporary installer file.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"cancel_installation"` | |
| `installer_name` | string | Filename of the installer to cancel (must match an active installation) |
| `deployment_id` | string | Deployment to cancel |

---

### uninstall_software

Uninstall software from the machine using registry uninstall commands.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"uninstall_software"` | |
| `software_name` | string | Display name of the software |
| `uninstall_command` | string | Registry uninstall string (from Windows Add/Remove Programs) |
| `silent_flags` | string | Silent uninstall flags (optional — auto-detected if omitted) |
| `installer_type` | string | Installer framework hint: `"nsis"`, `"inno"`, `"msi"` (optional) |
| `deployment_id` | string | Links to deployment for status tracking (optional) |
| `verify_paths` | array[string] | File paths to check are removed after uninstall (optional) |
| `timeout_seconds` | number | Max time to wait for uninstall in seconds (default: 1200 = 20 min) |

The agent parses the uninstall command, appends silent flags, executes the uninstaller, and checks exit codes (0 or 3010 = success). If `verify_paths` are provided, confirms those paths no longer exist.

---

### distribute_project

Download and extract a project ZIP.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"distribute_project"` | |
| `project_url` | string | Direct download URL |
| `project_name` | string | ZIP filename |
| `extract_path` | string | Target directory (optional, default: ~/Documents/OwletteProjects) |
| `verify_files` | array[string] | Files to verify after extraction (optional) |
| `distribution_id` | string | Links to project_distributions collection |

---

## system commands

### reboot_machine

Reboot the Windows machine.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"reboot_machine"` | |
| `delay` | number | Seconds before reboot (default: 0) |

---

### shutdown_machine

Shut down the Windows machine.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"shutdown_machine"` | |
| `delay` | number | Seconds before shutdown (default: 0) |

---

### update_owlette

Self-update the agent.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"update_owlette"` | |
| `installer_url` | string | URL to new installer |
| `version` | string | Target version number |

---

### cancel_reboot

Cancel a scheduled reboot or shutdown.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"cancel_reboot"` | |

---

### refresh_software_inventory

Refresh the software inventory snapshot for this machine.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"refresh_software_inventory"` | |

---

### cancel_distribution

Cancel an in-progress project distribution.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"cancel_distribution"` | |
| `distribution_id` | string | Distribution to cancel |

---

### cancel_uninstall

Cancel an in-progress software uninstall.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"cancel_uninstall"` | |
| `deployment_id` | string | Deployment to cancel uninstall for |

---

## ai/cortex commands

### mcp_tool_call

Execute an MCP tool call from Cortex.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_tool_call"` | |
| `tool_name` | string | MCP tool name (e.g., "get_system_info") |
| `arguments` | object | Tool-specific arguments |
| `chat_id` | string | Chat session ID |

**Result**: JSON-encoded tool response in the `result` field.

---

### provision_cortex_key

Provision an LLM API key for local Cortex (on-machine AI agent).

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"provision_cortex_key"` | |
| `api_key` | string | Encrypted LLM API key |
| `provider` | string | `"anthropic"` or `"openai"` |
