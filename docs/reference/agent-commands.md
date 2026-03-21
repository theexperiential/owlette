# Agent Commands Reference

Complete reference for all command types the agent accepts via Firestore.

---

## Command Lifecycle

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

## Command Document Schema

### Pending

```json
{
  "type": "command_type",
  "timestamp": 1711234567890,
  "status": "pending",
  ...command-specific fields
}
```

### Completed (Success)

```json
{
  "type": "command_type",
  "result": "Human-readable result message",
  "status": "completed",
  "completedAt": 1711234567900
}
```

### Completed (Failure)

```json
{
  "type": "command_type",
  "result": "Error: description of what went wrong",
  "status": "failed",
  "completedAt": 1711234567900
}
```

---

## Process Commands

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

### toggle_autolaunch

Toggle the autolaunch setting on/off.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"toggle_autolaunch"` | |
| `process_name` | string | Must match a configured process name |

---

## Configuration Commands

### update_config

Update process configuration from Firestore.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"update_config"` | |
| `processes` | array | New process configuration array |

---

## Deployment Commands

### install_software

Download and silently install software.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"install_software"` | |
| `installer_url` | string | Direct download URL |
| `installer_name` | string | Filename (e.g., "setup.exe") |
| `silent_flags` | string | Installation flags (e.g., "/VERYSILENT") |
| `verify_path` | string | Path to check after installation (optional) |
| `deployment_id` | string | Links to deployments collection |

---

### cancel_installation

Cancel an in-progress installation.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"cancel_installation"` | |
| `deployment_id` | string | Deployment to cancel |

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

## System Commands

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

### uninstall_owlette

Uninstall the agent from the machine.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"uninstall_owlette"` | |

---

## AI/Cortex Commands

### mcp_tool_call

Execute an MCP tool call from Cortex.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"mcp_tool_call"` | |
| `tool_name` | string | MCP tool name (e.g., "get_system_info") |
| `arguments` | object | Tool-specific arguments |
| `chat_id` | string | Chat session ID |

**Result**: JSON-encoded tool response in the `result` field.
