# cortex (ai chat)

Cortex is an AI-powered chat interface that lets you interact with your machines through natural language. Ask questions, run diagnostics, manage processes, and execute commands — all through conversation.

---

## overview

Cortex connects an LLM (Claude or OpenAI) to your machines via 29 specialized tools organized into three tiers:

| tier | type | approval | tools |
|------|------|----------|-------|
| **Tier 1** | Read-only | Auto-approved | 13 tools — system info, process lists, logs, metrics, GPU, site logs, presets |
| **Tier 2** | Process management | Auto-approved | 5 tools — restart, kill, start, set launch mode, screenshot |
| **Tier 3** | Privileged | Requires confirmation | 11 tools — run commands/scripts, read/write files, deploy software, reboot/shutdown |

---

## setup

### configure an llm provider

Cortex needs an API key from either **Anthropic (Claude)** or **OpenAI**.

#### user-level key

1. In the dashboard, open Cortex
2. Click the **settings gear** icon
3. Select **Provider**: Anthropic or OpenAI
4. Enter your **API key**
5. Optionally select a **model** (defaults to the latest)
6. Click **Save**

Your key is encrypted and stored in Firestore — it's never exposed to the client.

#### site-level key (admin)

Admins can set a shared API key for the entire site:

1. In the dashboard, open Cortex
2. Click the **settings gear** icon
3. Switch to the **"Site Key"** tab
4. Configure provider and key
5. All users on this site can use Cortex without their own key

**Priority**: User key takes precedence over site key.

---

## using cortex

1. Open Cortex from the dashboard
2. Select a **machine** to talk to
3. Type a message in natural language

### example conversations

**Check system health:**
> "How's the system doing? Any issues?"
>
> Cortex calls `get_system_info` and `get_agent_health`, then summarizes CPU, memory, disk usage, and connection status.

**Manage processes:**
> "Restart TouchDesigner"
>
> Cortex calls `restart_process` with `process_name: "TouchDesigner"` and reports the result.

**Diagnose issues:**
> "Why is the machine running slow?"
>
> Cortex calls `get_system_info`, `get_running_processes`, and `get_event_logs` to identify resource-heavy processes or recent errors.

**Run a command (Tier 3):**
> "Check the network configuration"
>
> Cortex requests confirmation to run `ipconfig /all`, then returns the output.

---

## tool tiers

### tier 1: read-only (auto-approved)

These tools only read information and never modify anything:

| tool | description |
|------|-------------|
| `get_site_logs` | Activity logs across all machines in the site (server-side) |
| `get_system_info` | CPU, memory, disk, GPU, hostname, OS, uptime, agent version |
| `get_process_list` | All owlette-configured processes with status |
| `get_running_processes` | All OS processes with CPU/memory usage (filterable) |
| `get_gpu_processes` | Per-process GPU/VRAM usage, sorted by consumption |
| `get_network_info` | Network interfaces, IP addresses, link status |
| `get_disk_usage` | All drives with total/used/free space |
| `get_event_logs` | Windows event logs (Application, System, Security) |
| `get_service_status` | Status of any Windows service |
| `get_agent_config` | owlette agent configuration (tokens stripped) |
| `get_agent_logs` | Recent agent log entries (filterable by level) |
| `get_agent_health` | Connection state, health probe results |
| `get_system_presets` | System presets for software deployments (server-side) |

### tier 2: process management (auto-approved)

These wrap existing owlette commands:

| tool | description |
|------|-------------|
| `restart_process` | Restart an owlette-configured process |
| `kill_process` | Kill/stop a process |
| `start_process` | Start a stopped process |
| `set_launch_mode` | Set launch mode (off, always, scheduled) |
| `capture_screenshot` | Capture a screenshot of the machine's desktop |

### tier 3: privileged (requires confirmation)

These tools require you to click **Confirm** before execution:

| tool | description |
|------|-------------|
| `run_command` | Execute a shell command (allowlist enforced) |
| `run_powershell` | Execute a PowerShell command (allowlist enforced) |
| `run_python` | Execute a Python script on the machine |
| `execute_script` | Execute a PowerShell script with no command restrictions |
| `read_file` | Read a file on the machine (max 100KB) |
| `write_file` | Write content to a file |
| `list_directory` | List directory contents with file sizes and dates |
| `deploy_software` | Install or uninstall software using a system preset |
| `reboot_machine` | Reboot the Windows machine |
| `shutdown_machine` | Shut down the Windows machine |
| `cancel_reboot` | Cancel a scheduled reboot or shutdown |

!!! info "Full tool reference"
    See [Cortex Tools Reference](../reference/cortex-tools.md) for complete parameter documentation and allowed command lists.

---

## how it works

```
User types message
    │
    ▼
POST /api/cortex (streaming)
    │
    ├── Resolve LLM config (user key → site key fallback)
    ├── Send messages + tool definitions to LLM
    │
    ▼
LLM decides to call a tool
    │
    ├── Tier 1/2: Auto-execute
    │     │
    │     ├── Write command to Firestore pending queue
    │     ├── Poll for completion (1.5s intervals, 30s timeout)
    │     └── Return result to LLM
    │
    └── Tier 3: Request user confirmation
          │
          ├── Dashboard shows confirmation dialog
          ├── User clicks Confirm/Deny
          └── If confirmed: execute and return result
```

---

## autonomous mode

Cortex can operate autonomously as a **cluster manager** — when a process crashes or fails to start, Cortex automatically investigates and attempts remediation without human intervention.

### how it works

```
Agent detects process crash
    │
    ▼
POST /api/agent/alert (existing alert system)
    │
    ├── Email notifications (existing)
    ├── Webhook notifications (existing)
    │
    └── Trigger autonomous Cortex (new)
          │
          ▼
    POST /api/cortex/autonomous (internal)
          │
          ├── Check: autonomous enabled for site?
          ├── Check: dedup/cooldown (same crash within 15 min?)
          ├── Check: concurrency (max 3 active sessions per site)
          │
          ▼
    generateText() with tool calling
          │
          ├── Read agent logs → look for errors
          ├── Check process status → confirm crash
          ├── Restart process → verify it's running
          │
          ▼
    Save conversation + update event record
          │
          ├── Resolved → logged for review
          └── Escalated → email admins
```

### the directive

Every autonomous investigation is guided by a **directive** — a customizable instruction that tells Cortex its mission. The default directive:

> *Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.*

Custom directives can be set per-site in Firestore (`sites/{siteId}/settings/cortex` → `directive` field).

### enabling autonomous mode

1. **Set the internal secret**: Add `CORTEX_INTERNAL_SECRET` environment variable in Railway (see [Environment Variables](../setup/environment-variables.md))
2. **Configure a site-level LLM key**: Autonomous mode uses the site key, not user keys (Cortex Settings → Site Key tab)
3. **Enable per site** in Firestore Console:
    - Navigate to `sites/{your-site-id}/settings/cortex`
    - Set `autonomousEnabled` to `true`

### configuration options

| setting | default | description |
|---------|---------|-------------|
| `autonomousEnabled` | `false` | Master switch — must be `true` for autonomous mode |
| `directive` | *(see above)* | Custom mission text for the AI |
| `maxTier` | `2` | Max tool tier (1=read-only, 2=+process management, 3=+shell commands) |
| `autonomousModel` | `null` | Override LLM model (e.g., use a cheaper model for autonomous) |
| `cooldownMinutes` | `15` | Wait time before re-investigating same machine+process |
| `maxEventsPerHour` | `10` | Max incoming events processed per hour per site |
| `escalationEmail` | `true` | Email site admins when Cortex escalates |

### guardrails

Autonomous Cortex has multiple safety layers:

- **Opt-in per site** — disabled by default, requires explicit admin action
- **Event dedup** — same machine+process won't be investigated again within the cooldown window
- **Concurrency cap** — max 3 simultaneous investigations per site
- **Step limit** — max 15 tool-calling rounds per investigation
- **Restart limit** — system prompt instructs max 2 restart attempts before escalating
- **Tier restriction** — default Tier 2 (no shell commands unless admin overrides)
- **Offline detection** — if the machine is offline, Cortex immediately escalates instead of wasting LLM calls

### reviewing autonomous actions

Autonomous conversations appear in the Cortex sidebar with a **⚡ auto** badge. Click to view exactly what Cortex investigated, which tools it called, and what actions it took.

Event records are stored in Firestore at `sites/{siteId}/cortex-events/` with full audit trails including tool calls, timestamps, and outcome summaries.

### escalation

When Cortex can't resolve an issue (restart fails, unexpected errors, machine offline), it:

1. Marks the event as **"escalated"**
2. Sends an **escalation email** to site admins with:
    - What happened (process name, machine, error)
    - What Cortex investigated and attempted
    - Why it's escalating
3. Logs the full conversation for review in the Cortex UI

---

## security

- **Allowlisted commands**: `run_command` and `run_powershell` only allow specific commands (e.g., `ipconfig`, `systeminfo`, `Get-Process`)
- **File size limits**: `read_file` limited to 100KB
- **Machine online check**: Cortex verifies the machine is online before executing
- **Encrypted API keys**: LLM keys are encrypted at rest in Firestore
- **No key exposure**: API keys never leave the server — streaming happens server-side
- **Autonomous auth**: Internal endpoint authenticated by shared secret, not exposed to public
