# Cortex: Local Agent SDK + Autonomous Mode — Unified Plan

**Created**: 2026-03-22
**Status**: Not Started
**Branch**: dev

---

## Goal

Transform Cortex from a server-side chat relay into a **locally-running AI agent** on each media server, with **autonomous investigation** capabilities. This is a single feature with two facets:

1. **Local Execution** — Cortex runs on the media server as a Python process using Claude Agent SDK. Tools execute directly (no Firestore relay). The web dashboard becomes a thin client.
2. **Autonomous Mode** — When a process crashes, Cortex automatically investigates locally, attempts remediation, and escalates to admins if unresolved.

Both facets share the same process (`owlette_cortex.py`), the same tools, the same constitution (`CLAUDE.md`), and the same Firestore data model.

**The Directive**: Cortex's core mission is to keep all configured processes running and machines operational.

---

## Architecture

```
Agent (4 processes, all isolated):
+-- owlette_service.py     -- Windows service (NSSM), monitoring, launches others
+-- owlette_tray.py        -- System tray icon, user session
+-- owlette_gui.py         -- Settings GUI, user session, on-demand
+-- owlette_cortex.py      -- AI agent (Agent SDK), user session  <-- NEW
```

### User Chat (single machine)
```
Browser -> POST /api/cortex -> writes pendingMessage to Firestore
  -> Local Cortex polls Firestore -> picks up message
  -> Agent SDK runs with local tools -> streams response
  -> Cortex writes response chunks to Firestore progressively (~500ms)
  -> Web API streams chunks back via SSE -> Browser renders
```

### Autonomous Investigation (local)
```
Service detects process crash
  -> Writes event to ipc/cortex_events/{id}.json
  -> Local Cortex detects event in main loop
  -> Runs Agent SDK with autonomous prompt + event context
  -> Tools execute locally (check logs, system info, restart process)
  -> Writes results to Firestore cortex-events collection
  -> If unresolved: writes escalation flag -> web picks up -> sends email
```

### Site-Wide Mode (unchanged)
```
Browser -> POST /api/cortex (site-wide target) -> Vercel AI SDK + Firestore relay
```
Site-wide queries still run on the web server — coordinating N independent local Cortex instances is too complex for this iteration.

---

## Event Scope (Autonomous)

**Process events only** for this iteration:
- `process_crash` — process stopped unexpectedly
- `process_start_failed` — process failed to launch

Connection failures and machine offline events are excluded — the machine is unreachable, so Cortex can't investigate locally.

---

## Phase 0: Cleanup — Revert Web-Side Constitution

Before building local Cortex, revert the server-side constitution that's being superseded:

| File | Action |
|------|--------|
| `web/lib/cortex-constitution.ts` | **DELETE** — content moves to `agent/CLAUDE.md` |
| `web/lib/llm.ts` | REVERT — remove constitution import, restore original `buildSystemPrompt()` |
| `web/lib/mcp-tools.ts` | REVERT — restore original tool descriptions |

**Keep** agent-side fixes (valuable regardless):
- `agent/src/mcp_tools.py`: Win11 detection, GPU key fix, `nvidia-smi` in allowlist, `gpu_driver_version`

---

## Phase 1: Agent-Side Foundation

### 1a. Create `agent/CLAUDE.md` — Constitution

The Agent SDK loads this automatically via `setting_sources=["project"]`. Deployed to `C:\ProgramData\Owlette\agent\CLAUDE.md`.

Content (~800-1200 tokens):
- Identity: Senior IT tech for interactive/immersive installations
- GPU awareness: VRAM, drivers, Mosaic, TDR, GeForce vs Quadro
- Windows hardening: auto-login, Update suppression, power mgmt, scheduled reboots
- Performance interpretation: contextualized for media servers vs kiosks vs signage
- Process health: TD, Unreal, Unity failure modes (memory leaks, GPU crashes)
- Scheduling & longevity: commissioning, content rotation, unattended operation
- Behavioral principles: use tools for real data, contextualize, flag issues
- Local execution context: tools run directly, no relay delay
- Tool safety: tiers, allowlist validation
- **Autonomous investigation rules**: investigate first, max 2 restarts, escalate with structured summary (ISSUE/INVESTIGATION/ACTION/OUTCOME)

### 1b. Create `agent/src/cortex_tools.py` — MCP Tool Wrappers

Wraps 19 existing tools from `mcp_tools.py` as Agent SDK `@tool()` decorated functions.

**Tier 1** (read-only, direct execution — 10 tools):
`get_system_info`, `get_process_list`, `get_running_processes`, `get_network_info`, `get_disk_usage`, `get_event_logs`, `get_service_status`, `get_agent_config`, `get_agent_logs`, `get_agent_health`

**Tier 2** (process management, via file-based IPC to service — 4 tools):
`restart_process`, `kill_process`, `start_process`, `set_launch_mode`

Cortex runs in user session, service runs as SYSTEM — can't share memory. IPC via `C:\ProgramData\Owlette\ipc\`:
- Cortex writes command to `ipc/cortex_commands/{cmd_id}.json`
- Service picks it up in main loop, executes, writes result to `ipc/cortex_results/{cmd_id}.json`
- Cortex polls for result (local file, sub-second latency)

**Tier 3** (privileged, direct execution — 5 tools):
`run_command`, `run_powershell`, `read_file`, `write_file`, `list_directory`

Also implement:
- `create_owlette_mcp_server(config)` — builds the MCP server with all tools
- `_write_ipc_command()` / `_poll_ipc_result()` — IPC helpers

### 1c. Create `agent/src/cortex_firestore.py` — Firestore Message Bridge

Uses existing `firebase_client.py` REST API (not firebase_admin).

- `poll_for_messages()` — check `sites/{siteId}/machines/{machineId}/cortex/active-chat` for `status === "pending"`
- `set_status(status)` — update active-chat status
- `write_response_chunk(content, parts)` — progressive response (~500ms / ~100 tokens)
- `write_final_response(content, parts, metadata)` — mark complete
- `write_cortex_heartbeat()` — update `cortexStatus.lastHeartbeat`
- `write_cortex_status(status)` — idle/thinking/tool_call/error
- `write_cortex_offline()` — mark offline on shutdown
- `write_autonomous_event(eventId, data)` — write investigation results to `cortex-events` collection
- `write_escalation_flag(eventId)` — flag event for web-side email escalation

### 1d. Create `agent/src/owlette_cortex.py` — Main Process

The 4th agent process. Asyncio event loop handling both user chat and autonomous events:

```python
async def main():
    config = shared_utils.read_config()
    api_key = decrypt_api_key(config)
    os.environ['ANTHROPIC_API_KEY'] = api_key

    owlette_server = cortex_tools.create_owlette_mcp_server(config)
    options = ClaudeAgentOptions(
        mcp_servers={"owlette": owlette_server},
        allowed_tools=["mcp__owlette__*", "Read", "Bash", "Glob", "Grep"],
        setting_sources=["project"],
        cwd="C:/ProgramData/Owlette/agent",
        permission_mode="acceptEdits",
        max_turns=15,
        max_budget_usd=2.0,
    )

    firestore = CortexFirestore(config)
    write_pid_file()

    while not shutdown_requested:
        await firestore.write_cortex_heartbeat()
        # User chat
        message = await firestore.poll_for_messages()
        if message:
            await handle_chat_message(message, options, firestore)
        # Autonomous events
        event = check_ipc_events()
        if event and passes_guardrails(event):
            await handle_autonomous_event(event, options, firestore)
        await asyncio.sleep(1.5)
```

Key features:
- **Singleton enforcement**: PID file at `C:\ProgramData\Owlette\tmp\cortex.pid`
- **Graceful shutdown**: Signal handler cleans PID, writes offline status
- **`handle_chat_message()`**: Run Agent SDK, stream response to Firestore
- **`handle_autonomous_event()`**: Run Agent SDK with autonomous prompt, write results to cortex-events
- **`passes_guardrails(event)`**: Local dedup/cooldown checks (see Phase 4 guardrails)

### 1e. Dependencies

Add `claude-agent-sdk>=0.1.0` to `agent/requirements.txt`.

---

## Phase 2: Service Integration

### 2a. Process Management (`owlette_service.py`)

Mirror the tray pattern (`_is_tray_alive()` / `_try_launch_tray()`):

- `self.cortex_pid`, `self._cortex_last_launch_time`, `self._cortex_launch_cooldown = 30`
- `_is_cortex_alive()` — check PID via psutil, fallback to process scan
- `_try_launch_cortex()` — check `config['cortex']['enabled']`, launch via `launch_python_script_as_user('owlette_cortex.py')` with cooldown
- Add call in main loop after `_try_launch_tray()`
- Add Cortex termination in `SvcStop()`

### 2b. IPC Command Handler (Tier 2 tools)

Add `_process_cortex_ipc_commands()` in service main loop:
- Scan `ipc/cortex_commands/` for `.json` files
- Parse command (tool_name, tool_params)
- Execute using existing command handling logic
- Write result to `ipc/cortex_results/{cmd_id}.json`
- Delete processed command file

### 2c. Autonomous Event Writing

When the service detects a process crash or start failure, write an event file:
- Path: `ipc/cortex_events/{evt_id}.json`
- Content: `{ processName, errorMessage, eventType, machineId, timestamp }`
- Cortex picks this up in its main loop (Phase 1d)

### 2d. Shared Utils Updates (`shared_utils.py`)

Add constants: `CORTEX_PID_PATH`, `CORTEX_IPC_CMD_DIR`, `CORTEX_IPC_RESULT_DIR`, `CORTEX_IPC_EVENTS_DIR`
Add helper: `is_cortex_enabled(config)`

---

## Phase 3: Web Integration

### 3a. Cortex API Route — Dual-Path (`web/app/api/cortex/route.ts`)

**Single-machine mode (NEW)**: Check Cortex heartbeat → write pendingMessage to Firestore → SSE stream from `onSnapshot`
**Site-wide mode (UNCHANGED)**: Keep existing Vercel AI SDK + Firestore relay

Add `isCortexLocal()` check: read `cortexStatus.online` + `lastHeartbeat` from Firestore. If stale (>30s), return 503.

SSE events: `delta`, `tool_call`, `tool_result`, `complete`, `error`
Timeout: 60s max, close stream with error if no response.

### 3b. Chat Hook — SSE Transport (`web/hooks/useCortex.ts`)

Custom SSE handler for single-machine mode:
- Handle events: delta, tool_call, tool_result, complete
- Build UIMessage objects with correct parts for ChatWindow/ToolCallCard rendering
- Maintain backward compatibility for site-wide mode

### 3c. Key Provisioning (`web/app/api/cortex/provision-key/route.ts`)

Authenticate user → decrypt API key → write Firestore command → Service receives `provision_cortex_key` → encrypts with SecureStorage (Fernet) → stores in config.json

---

## Phase 4: Autonomous Mode — Guardrails & Investigation

This phase wires up the autonomous investigation triggered by Phase 2c events, with production-grade guardrails.

### Guardrails (implemented in `owlette_cortex.py`)

| Guardrail | Mechanism | Default |
|-----------|-----------|---------|
| Event dedup | Local file check: skip if same machine+process within cooldown | 15 min cooldown |
| Concurrency cap | Local counter: max simultaneous investigations | Max 3 per Cortex instance |
| Step limit | `max_turns` in Agent SDK options | 15 steps |
| Restart cap | Constitution instruction in CLAUDE.md | Max 2 per session |
| Tier restriction | `maxTier` from config | Tier 2 (no shell by default) |
| Offline detection | Skip if machine metrics stale | Immediate skip |
| Opt-in | `config['cortex']['autonomousEnabled']` | Disabled by default |
| Rate limit | Max events per hour | 10 per hour |
| Budget cap | `max_budget_usd` in Agent SDK | $2.00 per investigation |

### Autonomous Prompt

Built dynamically in `handle_autonomous_event()`:

```
You are Owlette Cortex operating in AUTONOMOUS mode. You have been triggered
by a system alert — no human initiated this conversation.

YOUR DIRECTIVE: {directive from config, or default}

CURRENT EVENT:
Process "{processName}" {crashed/failed to start} on machine "{machineName}".
Error: {errorMessage}

RULES:
1. INVESTIGATE FIRST — check agent logs and process status before acting
2. RESTART LIMIT — max 2 restarts for the same process in this session
3. ESCALATE — if unresolved after investigation + restarts, say "ESCALATION NEEDED"
4. BE EFFICIENT — minimize tool calls, focus on the specific issue
5. ALWAYS SUMMARIZE:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention
```

### Firestore Data Model

**`sites/{siteId}/cortex-events/{eventId}`** — Event audit trail (written by local Cortex):
```json
{
  "machineId": "MEDIA-PC-01",
  "machineName": "Media Server",
  "processName": "TouchDesigner",
  "eventType": "process_crash",
  "errorMessage": "Process stopped unexpectedly",
  "timestamp": "<Timestamp>",
  "chatId": "auto_1711036800000_MEDIA-PC-01",
  "status": "investigating | resolved | escalated | failed",
  "summary": "Restarted TouchDesigner successfully",
  "actions": [
    { "tool": "get_agent_logs", "timestamp": "<Timestamp>" },
    { "tool": "restart_process", "params": { "process_name": "TouchDesigner" }, "timestamp": "<Timestamp>" }
  ],
  "resolvedAt": "<Timestamp>",
  "durationMs": 45000,
  "source": "local"
}
```

**`sites/{siteId}/settings/cortex`** — Config (set via Firestore console initially):
```json
{
  "autonomousEnabled": false,
  "directive": "",
  "maxTier": 2,
  "maxEventsPerHour": 10,
  "cooldownMinutes": 15,
  "escalationEmail": true
}
```

**Firestore Index** (add to `firestore.indexes.json`):
```json
{
  "collectionGroup": "cortex-events",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "machineId", "order": "ASCENDING" },
    { "fieldPath": "processName", "order": "ASCENDING" },
    { "fieldPath": "timestamp", "order": "DESCENDING" }
  ]
}
```

### Alert Route Fallback (`web/app/api/agent/alert/route.ts`)

Modify the alert route to check whether local Cortex is running:
- If Cortex heartbeat is fresh → **skip server-side investigation** (local Cortex handles it via IPC)
- If Cortex heartbeat is stale/missing → **fall back to server-side investigation** using existing `cortex-utils.server.ts` + `generateText()` approach (keep as fallback only)

This ensures autonomous mode works even when local Cortex is offline.

---

## Phase 5: Escalation System

**New file:** `web/lib/cortex-escalation.server.ts`

Local Cortex writes an escalation flag to Firestore when it can't resolve an issue. The web server picks this up and sends the email (Cortex doesn't have Resend credentials).

### Flow
```
Local Cortex determines escalation needed
  -> Writes to cortex-events: { status: "escalated", escalationPending: true }
  -> Web picks up via Firestore trigger or polling
  -> Sends escalation email via Resend
```

### `escalate()` function
```typescript
export async function escalate(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  eventId: string,
  machineName: string,
  processName: string,
  cortexSummary: string
): Promise<void> {
  const recipients = await getSiteAdminEmails(siteId, true);
  if (recipients.length === 0) return;

  const subject = `[Cortex] Escalation: ${processName} on ${machineName}`;
  const html = buildEscalationEmail(machineName, processName, cortexSummary, eventId);

  const resend = getResend();
  if (!resend) return;

  await resend.emails.send({ from: FROM_EMAIL, to: recipients, subject, html });
}
```

### Escalation Pickup

New endpoint or cron-like check: `web/app/api/cortex/escalation/route.ts`
- Polls `cortex-events` where `escalationPending === true`
- Sends email, clears flag
- OR: wire into existing alert route as a Firestore-triggered check

---

## Phase 6: UI — Autonomous Badge + Events

### Autonomous Chat Badge (`web/app/cortex/page.tsx`)

In the conversation list sidebar:
- If chat `source === 'autonomous'`: show `<Badge>Auto</Badge>` or `<Zap />` icon
- Autonomous chats viewable read-only alongside user chats, sorted by timestamp

### Cortex Events View (minimal)

Show recent autonomous events somewhere accessible (cortex sidebar or settings):
- Event list with status badges (resolved/escalated/failed)
- Click to view the autonomous conversation
- No need for a full dashboard — just visibility

---

## Phase 7: Installer & Finalization

- Add `claude-agent-sdk` to pip install in `agent/build_installer_full.bat`
- Add `CLAUDE.md` to files section in `agent/owlette_installer.iss`
- Add new `.py` files (`owlette_cortex.py`, `cortex_tools.py`, `cortex_firestore.py`) to installer
- Ensure `ipc/` subdirectories created by installer or on first run
- Version bump with `node scripts/sync-versions.js X.Y.Z`
- Test full installer build

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `web/lib/cortex-constitution.ts` | DELETE | 0 |
| `web/lib/llm.ts` | REVERT (remove constitution) | 0 |
| `web/lib/mcp-tools.ts` | REVERT (restore descriptions) | 0 |
| `agent/CLAUDE.md` | CREATE | 1 |
| `agent/src/cortex_tools.py` | CREATE | 1 |
| `agent/src/cortex_firestore.py` | CREATE | 1 |
| `agent/src/owlette_cortex.py` | CREATE | 1 |
| `agent/requirements.txt` | EDIT (add claude-agent-sdk) | 1 |
| `agent/src/owlette_service.py` | EDIT (process mgmt + IPC + event writing) | 2 |
| `agent/src/shared_utils.py` | EDIT (cortex constants) | 2 |
| `web/app/api/cortex/route.ts` | REWRITE (dual-path) | 3 |
| `web/hooks/useCortex.ts` | EDIT (SSE transport) | 3 |
| `web/app/api/cortex/provision-key/route.ts` | CREATE | 3 |
| `web/app/api/agent/alert/route.ts` | EDIT (local Cortex fallback check) | 4 |
| `web/lib/cortex-escalation.server.ts` | CREATE | 5 |
| `web/app/api/cortex/escalation/route.ts` | CREATE | 5 |
| `web/app/cortex/page.tsx` | EDIT (auto badge + events) | 6 |
| `firestore.indexes.json` | EDIT (add cortex-events index) | 4 |
| `agent/build_installer_full.bat` | EDIT | 7 |
| `agent/owlette_installer.iss` | EDIT | 7 |

## Environment Variables

| Variable | Purpose | Where |
|----------|---------|-------|
| `CORTEX_INTERNAL_SECRET` | Fallback: server-side autonomous endpoint auth | Railway env |

---

## Prerequisites

- WS0 (Admin API) — for testing via `/api/admin/events/simulate` (**done**)
- WS1 (Crash Alerts) — the alert endpoint (**done**)
- WS2 (Webhooks) — webhook firing (**done**)
- Existing Cortex MVP — chat UI, tool system, LLM config (**done**)

---

## Testing

### Phase 1 Verification
- Run `owlette_cortex.py` manually, send message via Firestore, verify response
- Verify tool results (get_system_info returns real data)
- Verify heartbeat updating

### Phase 2 Verification
- Stop/start service — Cortex auto-launches
- Kill Cortex — service relaunches within 30s
- Test Tier 2 IPC round-trip

### Phase 3 Verification
- Web dashboard chat with streaming response + tool call cards
- Site-wide mode still works

### Phase 4 Verification
- Kill a managed process → Cortex detects via IPC → investigates locally
- Verify dedup/cooldown prevents duplicate investigations
- Verify results written to Firestore cortex-events

### Phase 5 Verification
- Escalation email sent when Cortex can't resolve

### End-to-End Scenarios
- "What GPU does this machine have?" — domain-contextualized answer
- "Is this machine ready for a 24/7 TouchDesigner installation?" — holistic assessment
- Kill managed process → autonomous investigation → resolution or escalation
- Kill Cortex process → other processes unaffected, relaunches within 30s
- Site-wide mode query → still works via web server
- Cortex offline → alert route falls back to server-side investigation
