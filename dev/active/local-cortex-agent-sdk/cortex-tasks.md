# Cortex — Unified Task Checklist

**Last Updated**: 2026-03-22

## Phase 0: Cleanup — Revert Web-Side Constitution

- [ ] Delete `web/lib/cortex-constitution.ts`
- [ ] Revert `web/lib/llm.ts` — remove constitution import, restore original `buildSystemPrompt()`
- [ ] Revert `web/lib/mcp-tools.ts` — restore original tool descriptions
- [ ] Run `npm run build` in web/ — verify clean build
- [ ] Verify: agent-side fixes in `mcp_tools.py` NOT reverted (Win11, GPU key, nvidia-smi, driver version)

## Phase 1: Agent-Side Foundation

### 1a. Constitution
- [ ] Create `agent/CLAUDE.md` with full domain expertise + autonomous investigation rules

### 1b. MCP Tool Wrappers (`cortex_tools.py`)
- [ ] Create `agent/src/cortex_tools.py`
- [ ] Wrap Tier 1 read-only tools (10 tools): get_system_info, get_process_list, get_running_processes, get_network_info, get_disk_usage, get_event_logs, get_service_status, get_agent_config, get_agent_logs, get_agent_health
- [ ] Wrap Tier 2 process management tools via IPC (4 tools): restart_process, kill_process, start_process, set_launch_mode
- [ ] Wrap Tier 3 privileged tools (5 tools): run_command, run_powershell, read_file, write_file, list_directory
- [ ] Implement `create_owlette_mcp_server(config)`
- [ ] Implement `_write_ipc_command()` / `_poll_ipc_result()` helpers

### 1c. Firestore Message Bridge (`cortex_firestore.py`)
- [ ] Create `agent/src/cortex_firestore.py` using existing `firebase_client.py` REST API
- [ ] Implement `poll_for_messages()` — check active-chat doc for status "pending"
- [ ] Implement `write_response_chunk()` + `write_final_response()` — progressive updates
- [ ] Implement `write_cortex_heartbeat()` + `write_cortex_status()` + `write_cortex_offline()`
- [ ] Implement `write_autonomous_event()` + `write_escalation_flag()` — for Phase 4

### 1d. Main Cortex Process (`owlette_cortex.py`)
- [ ] Create `agent/src/owlette_cortex.py`
- [ ] API key decryption from config.json (SecureStorage pattern)
- [ ] Agent SDK client initialization with ClaudeAgentOptions
- [ ] PID file + singleton check
- [ ] Main asyncio loop: poll messages, heartbeat, IPC events
- [ ] `handle_chat_message()` — run Agent SDK, stream response to Firestore
- [ ] `handle_autonomous_event()` — run Agent SDK with autonomous prompt
- [ ] `check_ipc_events()` — poll ipc/cortex_events/ directory
- [ ] `passes_guardrails(event)` — dedup, cooldown, concurrency, rate limit
- [ ] Signal handler for graceful shutdown
- [ ] Logging to agent's existing log directory

### 1e. Dependencies
- [ ] Add `claude-agent-sdk>=0.1.0` to `agent/requirements.txt`
- [ ] Test pip install in embedded Python 3.11.8
- [ ] Verify no conflicts with existing packages

### Phase 1 Checkpoint
- [ ] Run `owlette_cortex.py` manually, send test message via Firestore, verify response
- [ ] Verify tools return real data
- [ ] Verify heartbeat updating

## Phase 2: Service Integration

### 2a. Process Management (`owlette_service.py`)
- [ ] Add Cortex instance variables (`cortex_pid`, `_cortex_last_launch_time`, cooldown)
- [ ] Implement `_is_cortex_alive()` — mirror tray pattern
- [ ] Implement `_try_launch_cortex()` — check config, launch with cooldown
- [ ] Add to main loop after `_try_launch_tray()`
- [ ] Add Cortex termination in `SvcStop()`

### 2b. IPC Command Handler (Tier 2 tools)
- [ ] Implement `_process_cortex_ipc_commands()` — scan, parse, execute, write result
- [ ] Add to main loop
- [ ] Ensure IPC directories created if missing

### 2c. Autonomous Event Writing
- [ ] On process crash/start failure, write event to `ipc/cortex_events/{id}.json`
- [ ] Include: processName, errorMessage, eventType, machineId, timestamp

### 2d. Shared Utils (`shared_utils.py`)
- [ ] Add constants: `CORTEX_PID_PATH`, `CORTEX_IPC_CMD_DIR`, `CORTEX_IPC_RESULT_DIR`, `CORTEX_IPC_EVENTS_DIR`
- [ ] Add `is_cortex_enabled(config)` helper

### Phase 2 Checkpoint
- [ ] Stop/start service — Cortex auto-launches
- [ ] Kill Cortex — relaunches within 30s
- [ ] Enable/disable in config — respects flag
- [ ] Tier 2 IPC round-trip works
- [ ] Service/tray/GUI unaffected when Cortex crashes

## Phase 3: Web Integration

### 3a. Cortex API Route — Dual-Path
- [ ] Rewrite `web/app/api/cortex/route.ts`: single-machine (SSE) vs site-wide (existing)
- [ ] Implement `isCortexLocal()` — check cortexStatus heartbeat freshness
- [ ] Implement SSE stream with events: delta, tool_call, tool_result, complete, error
- [ ] Implement onSnapshot listener with cleanup + 60s timeout

### 3b. Chat Hook — SSE Transport
- [ ] Modify `web/hooks/useCortex.ts` for single-machine SSE
- [ ] Build UIMessage objects for ChatWindow/ToolCallCard rendering
- [ ] Maintain backward compat for site-wide mode

### 3c. Key Provisioning
- [ ] Create `web/app/api/cortex/provision-key/route.ts`
- [ ] Service handler: receive command → encrypt → store in config.json

### Phase 3 Checkpoint
- [ ] Web dashboard chat with streaming + tool call cards
- [ ] Site-wide mode still works
- [ ] Error cases: Cortex offline, timeout, missing key

## Phase 4: Autonomous Mode — Guardrails & Firestore

- [ ] Wire `handle_autonomous_event()` to use guardrails: dedup (15min), concurrency (max 3), rate limit (10/hr), budget ($2)
- [ ] Build autonomous prompt dynamically with event context + directive
- [ ] Write investigation results to Firestore `cortex-events` collection
- [ ] Add Firestore index for cortex-events (machineId + processName + timestamp)
- [ ] Modify alert route: skip server-side Cortex if local heartbeat is fresh, fall back if stale
- [ ] Configure `sites/{siteId}/settings/cortex` schema (autonomousEnabled, directive, maxTier, cooldown, etc.)

### Phase 4 Checkpoint
- [ ] Kill managed process → Cortex investigates locally
- [ ] Dedup/cooldown prevents duplicates
- [ ] Results written to Firestore cortex-events
- [ ] Alert route falls back to server-side when Cortex offline

## Phase 5: Escalation System

- [ ] Create `web/lib/cortex-escalation.server.ts` with `escalate()` function
- [ ] Create `web/app/api/cortex/escalation/route.ts` — pickup escalation flags from Firestore
- [ ] Build escalation email template (machine, process, Cortex summary, dashboard link)
- [ ] Send via Resend to site admin emails

### Phase 5 Checkpoint
- [ ] Unresolvable issue → escalation email sent to admins

## Phase 6: UI — Auto Badge + Events

- [ ] Add autonomous chat badge in Cortex sidebar (source === 'autonomous' → Auto badge)
- [ ] Autonomous chats viewable read-only
- [ ] Show recent cortex-events with status badges (resolved/escalated/failed)
- [ ] Click event → view autonomous conversation

## Phase 7: Installer & Finalization

- [ ] Add `claude-agent-sdk` to pip install in `agent/build_installer_full.bat`
- [ ] Add `CLAUDE.md` to files in `agent/owlette_installer.iss`
- [ ] Add new .py files to installer (or verify src/* glob catches them)
- [ ] Ensure `ipc/` subdirectories created
- [ ] Test full installer build
- [ ] Version bump: `node scripts/sync-versions.js X.Y.Z`

## End-to-End Testing

- [ ] "What GPU does this machine have?" — domain-contextualized answer
- [ ] "Is this ready for a 24/7 TouchDesigner installation?" — holistic assessment
- [ ] Kill managed process → autonomous investigation → resolution or escalation
- [ ] Kill Cortex → other processes unaffected, relaunches within 30s
- [ ] Site-wide query → works via web server
- [ ] Cortex offline → alert route falls back to server-side
- [ ] Build passes (`npm run build` + agent install)

---
**Last Updated**: 2026-03-22
