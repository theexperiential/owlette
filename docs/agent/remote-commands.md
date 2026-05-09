# remote commands

The agent listens for commands from the web dashboard via Firestore. Commands are written as entries in a pending command map, executed by the agent, and mirrored into a completed command map as progress, completion, failure, or cancellation records.

---

## command lifecycle

```
Dashboard                      Firestore                         Agent
  |                               |                                |
  |-- merge command id ---------->|                                |
  |   into commands/pending       |-- listener detects ----------->|
  |                               |                                |-- execute
  |                               |                                |
  |                               |<-- merge result/progress ------|
  |<-- listener updates UI -------|   into commands/completed      |
```

Each machine has two command documents:

- `sites/{siteId}/machines/{machineId}/commands/pending`
- `sites/{siteId}/machines/{machineId}/commands/completed`

Both documents store command IDs as top-level map fields. A successful terminal write removes the matching field from `pending`.

---

## command types

### process management

| command | description | data payload |
|---------|-------------|--------------|
| `restart_process` | Restart a configured process | `{process_name?, process_id?}` |
| `start_process` | Start a configured process | `{process_name?, process_id?}` |
| `stop_process` | Stop a configured process | `{process_name?, process_id?}` |
| `kill_process` | Terminate a process | `{process_name?, process_id?}` |
| `set_launch_mode` | Set launch mode (`off`, `always`, or `scheduled`) | `{process_name?, process_id?, processId?, mode, schedules?}` |
| `toggle_autolaunch` | Legacy launch-mode toggle | `{process_name?, process_id?, processId?, autolaunch}` |
| `capture_screenshot` | Capture desktop screenshot | `{monitor}` (0=all, 1=primary, etc.) |

For `set_launch_mode` and `toggle_autolaunch`, the agent matches `process_id` / `processId` first and falls back to `process_name`. `set_launch_mode` persists the requested `mode` and any supplied `schedules`.

### configuration

| command | description | data payload |
|---------|-------------|--------------|
| `update_config` | Update process configuration from cloud | `{config}` |

### software deployment

| command | description | data payload |
|---------|-------------|--------------|
| `install_software` | Download, checksum, and install software | `{installer_url, sha256_checksum, installer_name?, silent_flags?, verify_path?, timeout_seconds?, deployment_id?, parallel_install?, close_processes?, suppress_projects?}` |
| `cancel_installation` | Cancel an in-progress installer process | `{installer_name}` |
| `uninstall_software` | Run a software uninstaller | `{software_name, uninstall_command, silent_flags?, installer_type?, verify_paths?, timeout_seconds?, deployment_id?}` |
| `cancel_uninstall` | Cancel an in-progress uninstall process | `{software_name}` |

### project distribution

Current project distribution uses roost v2 handlers registered through the agent command router:

| command | description | data payload |
|---------|-------------|--------------|
| `sync_pull` | Fetch a roost version manifest, download required chunks, and assemble files at the target root | `{site_id, roost_id, version_id, version_url, extract_root}` |
| `cancel_sync` | Signal cancellation for an in-flight roost sync | `{site_id, roost_id, version_id}` |
| `rollback_to_version` | Pull an older roost version after the server-side rollback pointer changes | `{site_id, roost_id, version_id, version_url, extract_root}` |

Legacy v1 ZIP distribution still ships in the agent for older dashboard paths:

| command | description | data payload |
|---------|-------------|--------------|
| `distribute_project` | Legacy ZIP download and extraction | `{project_url, project_name?, extract_path?, distribution_id?}` |
| `cancel_distribution` | Legacy ZIP distribution cancellation | `{project_name}` |

### system commands

| command | description | data payload |
|---------|-------------|--------------|
| `reboot_machine` | Reboot the machine after the agent announces a 30-second OS countdown | `{}` |
| `shutdown_machine` | Shut down the machine after the agent announces a 30-second OS countdown | `{}` |
| `cancel_reboot` | Abort a pending OS reboot/shutdown countdown | `{}` |
| `dismiss_reboot_pending` | Clear dashboard reboot-pending state | `{process_name?}` |
| `update_owlette` | Self-update the agent via a scheduled SYSTEM task | `{installer_url, checksum_sha256, target_version?, deployment_id?}` |

The agent does not provide a remote self-uninstall command. Remote software removal uses `uninstall_software` for third-party applications.

### ai/cortex tools

| command | description | data payload |
|---------|-------------|--------------|
| `mcp_tool_call` | Execute a Cortex tool | `{tool_name, tool_params, chat_id?}` |

!!! info "Cortex tool reference"
    See the [Cortex Tools Reference](../reference/cortex-tools.md) for the canonical tool list with parameters, tiers, and allowed commands.

---

## command document structure

### pending command

Written as one field inside `sites/{siteId}/machines/{machineId}/commands/pending`:

```json
{
  "restart_process_machineA_1711234567890": {
    "type": "restart_process",
    "process_name": "TouchDesigner",
    "createdAt": "<server timestamp>",
    "expiresAt": "<timestamp>",
    "status": "pending"
  }
}
```

### completed command

Merged into `sites/{siteId}/machines/{machineId}/commands/completed`, then removed from `pending`:

```json
{
  "restart_process_machineA_1711234567890": {
    "type": "restart_process",
    "result": "Process 'TouchDesigner' restarted successfully (PID: 12345)",
    "status": "completed",
    "completedAt": "<server timestamp>"
  }
}
```

### failed command

```json
{
  "restart_process_machineA_1711234567890": {
    "type": "restart_process",
    "error": "Process 'TouchDesigner' not found in configuration",
    "status": "failed",
    "completedAt": "<server timestamp>"
  }
}
```

Progress updates are also merged into the completed document under the same command ID with fields such as `status`, `progress`, `deployment_id`, and `updatedAt`. Terminal states include `completed`, `failed`, and `cancelled`.

---

## command polling (dashboard)

When the dashboard sends a command with `wait: true`, it polls for completion:

1. Merge the command into the pending map document.
2. Poll the completed map document for the command ID every 1.5 seconds.
3. Timeout after 30-120 seconds, depending on the caller.
4. Return the completed, failed, cancelled, or timeout result.

This is used by the Admin API (`/api/admin/commands/send`) and Cortex tool execution.

---

## software installation flow

The `install_software` command triggers a multi-step process:

```
1. Download installer to the agent temp installer directory.
   Progress: downloading 0% to 100%

2. Verify sha256_checksum.
   Missing or mismatched checksums fail the command before execution.

3. Optionally stop conflicting processes and suppress managed projects.
   Controlled by close_processes and suppress_projects.

4. Execute installer with silent flags in the interactive user's session.
   Progress: installing, then waiting for exit code.

5. Verify installation if verify_path is provided or derived from /DIR.

6. Cleanup temp file, release install locks, and sync software inventory.
```

### install_software payload

| field | required | default | notes |
|-------|----------|---------|-------|
| `installer_url` | yes | none | URL downloaded by the agent. |
| `sha256_checksum` | yes | none | Command is refused without this checksum. |
| `installer_name` | no | `installer.exe` | Used for the temp filename and process tracking. |
| `silent_flags` | no | empty string | Passed to the installer. `/DIR=...` can auto-fill `verify_path`. |
| `verify_path` | no | auto-derived from `/DIR` when possible | Checked after installer success. |
| `timeout_seconds` | no | `2400` | Installer timeout in seconds. |
| `deployment_id` | no | none | Included in progress records. |
| `parallel_install` | no | `false` | Temporarily hides matching registry keys during install. |
| `close_processes` | no | `[]` | Process names to terminate before install. |
| `suppress_projects` | no | `[]` | Managed project IDs to lock during install. |

### supported installer types

| type | silent flag | example |
|------|-------------|---------|
| **Inno Setup** | `/VERYSILENT /SUPPRESSMSGBOXES` | owlette itself |
| **NSIS** | `/S` | Notepad++ |
| **MSI** | `msiexec /i installer.msi /qn` | Windows Installer packages |
| **Custom** | Varies | Any executable with silent flags |

---

## project distribution flow

### roost v2 sync

The `sync_pull` command is the current distribution path:

```
1. Validate required site, roost, version, URL, and target-root fields.
2. Check the site-level roost kill switch.
3. Report the target state as pending.
4. Mint a fresh version download URL when the Firebase client can do so.
5. Fetch and validate the version manifest.
6. Diff against the most recent local committed version for that roost.
7. Register or resume a local distribution row.
8. Download missing chunks with throttled progress updates.
9. Assemble files atomically into extract_root.
10. Commit the distribution and report final target state.
```

`cancel_sync` looks up the matching in-flight distribution by `site_id`, `roost_id`, and `version_id`, then signals its cancellation event. `rollback_to_version` reuses the same `sync_pull` path; the server-side roost rollback has already selected the older version.

### legacy v1 ZIP distribution

`distribute_project` remains available for older dashboard paths only. It downloads a ZIP archive, extracts it to `extract_path` or the default Owlette projects directory, optionally checks expected extracted paths, cleans up the ZIP, and reports progress with the legacy `distribution_id`.

---

## system command details

### reboot / shutdown

Manual reboot and shutdown commands do not accept configurable countdown fields. The agent sets local shutdown intent, announces the state to Firestore, then invokes Windows with a fixed 30-second countdown:

```python
subprocess.run(['shutdown', '/r', '/t', '30', '/c', 'owlette remote reboot requested'])
subprocess.run(['shutdown', '/s', '/t', '30', '/c', 'owlette remote shutdown requested'])
```

`cancel_reboot` aborts the pending OS countdown with `shutdown /a` and clears the dashboard flags when Firestore is available.

### self-update

`update_owlette` requires `installer_url` and `checksum_sha256`. The agent derives `target_version` from the payload or URL, downloads the installer to `C:\ProgramData\owlette\tmp`, verifies the checksum, writes an update marker, and launches the installer through a one-time scheduled task running as SYSTEM. A recovery scheduled task attempts to restart the service if it does not return after the update.
