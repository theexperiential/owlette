# Cortex — Context & Integration Points

**Last Updated**: 2026-03-22
**Note**: This file supports the unified plan in `cortex-plan.md` and `cortex-tasks.md`.

## Key Files

### To Create
- `agent/CLAUDE.md` — Constitution loaded by Agent SDK (domain expertise for interactive/immersive installations)
- `agent/src/owlette_cortex.py` — Main Cortex process (asyncio loop, Agent SDK client, Firestore bridge)
- `agent/src/cortex_tools.py` — Wraps 19 existing tools from mcp_tools.py as Agent SDK @tool() functions
- `agent/src/cortex_firestore.py` — Firestore REST polling for messages + progressive response writing
- `web/app/api/cortex/provision-key/route.ts` — API key provisioning endpoint

### To Modify
- `agent/src/owlette_service.py` — Add Cortex process lifecycle (launch, monitor, restart, IPC command handler)
- `agent/src/shared_utils.py` — Add Cortex path constants (PID, IPC dirs)
- `agent/requirements.txt` — Add `claude-agent-sdk>=0.1.0`
- `web/app/api/cortex/route.ts` — Rewrite: dual-path (local Cortex SSE vs site-wide existing)
- `web/hooks/useCortex.ts` — Custom SSE transport for single-machine mode
- `agent/build_installer_full.bat` — Add claude-agent-sdk to pip install
- `agent/owlette_installer.iss` — Add CLAUDE.md to files section

### To Delete/Revert
- `web/lib/cortex-constitution.ts` — DELETE (content moves to agent/CLAUDE.md)
- `web/lib/llm.ts` — REVERT constitution import, restore original buildSystemPrompt()
- `web/lib/mcp-tools.ts` — REVERT tool description changes

### Reference (no changes)
- `agent/src/mcp_tools.py` — 19 tool implementations (already has Win11 fix, GPU fix, nvidia-smi, driver version)
- `agent/src/firebase_client.py` — REST API client (cortex_firestore.py will use this)
- `web/lib/cortex-utils.server.ts` — Keep for site-wide mode (executeToolOnAgent, buildExecutableTools)
- `web/lib/cortex-escalation.server.ts` — Keep for autonomous escalation emails
- `web/app/cortex/components/*` — UI components (unchanged, render based on message parts)

## Architectural Decisions

1. **Local execution over Firestore relay** — Tools execute directly on the media server. Eliminates round-trip latency and Firestore dependency for tool calls. Rationale: these are IT management tools running on the machine they manage.

2. **Python Agent SDK over TypeScript** — Matches existing agent codebase (all Python). Fewer runtime dependencies. Embedded Python 3.11.8 already satisfies Agent SDK's 3.10+ requirement.

3. **Site-wide mode stays on web server** — Coordinating N independent local Cortex instances is complex. Web server continues to handle site-wide queries using existing Vercel AI SDK approach.

4. **File-based IPC for Tier 2 tools** — Cortex runs in user session, service runs as SYSTEM. Can't share memory. File-based IPC in `C:\ProgramData\Owlette\ipc\` mirrors existing patterns (config.json, service_status.json, flag files).

5. **Progressive Firestore writes for streaming** — Cortex writes response chunks to a Firestore document every ~500ms. Web API uses `onSnapshot` + SSE to stream to browser. ~500-800ms perceived latency.

6. **API key stored locally encrypted** — Provisioned via Firestore command, encrypted with machine-specific SecureStorage (Fernet), stored in config.json. Works offline after initial provisioning.

7. **Process isolation** — Cortex is a separate process launched by the service. Crash doesn't affect monitoring, tray, or GUI. Service relaunches it with 30s cooldown.

## Integration Points

### Agent ↔ Cortex (local IPC)
- **PID file**: `C:\ProgramData\Owlette\tmp\cortex.pid` — service monitors
- **Tier 2 commands**: `ipc\cortex_commands\{id}.json` → `ipc\cortex_results\{id}.json`
- **Autonomous events**: `ipc\cortex_events\{id}.json` — service writes, Cortex reads
- **Config**: Shared `config.json` with mutex locking (`Global\OwletteJsonFileMutex`)
- **Launch**: Service spawns Cortex via `launch_python_script_as_user()` (user session, like tray)

### Cortex ↔ Firestore (remote)
- **Messages in**: `sites/{siteId}/machines/{machineId}/cortex/active-chat` (status: pending)
- **Responses out**: Same document, `response` field updated progressively
- **Heartbeat**: `cortexStatus.lastHeartbeat` updated every loop iteration (~1.5s)
- **Autonomous results**: `sites/{siteId}/cortex-events/{eventId}`
- **Uses**: Existing `firebase_client.py` REST API (not firebase_admin)

### Web ↔ Firestore ↔ Cortex
- **Single machine**: Web writes pendingMessage → Cortex polls → responds → Web streams via SSE
- **Site-wide**: Web calls LLM directly → relays tools via Firestore commands (existing approach)
- **Key provisioning**: Web writes `provision_cortex_key` command → Service stores encrypted

### Web Dashboard UI
- Chat components (`ChatWindow`, `ToolCallCard`, `ChatInput`) stay unchanged
- They render based on `message.parts` array — same structure from both local and site-wide paths
- `useCortex.ts` needs custom SSE transport for single-machine path

## Dependencies

### New Python packages
- `claude-agent-sdk>=0.1.0` — Claude Agent SDK (brings httpx, pydantic as transitive deps)

### No new npm packages needed

### Internal dependencies (order matters)
1. Part 0 (cleanup) has no dependencies
2. Part 1 (agent foundation) depends on Part 0
3. Part 2 (service integration) depends on Part 1
4. Part 3 (web integration) depends on Part 2 (needs working Cortex to test against)
5. Part 4 (autonomous) depends on Parts 1-3
6. Part 5 (installer) depends on all above

## Data Flow

### User Chat (Single Machine)
```
User types message in browser
  → POST /api/cortex (web server)
  → Write pendingMessage to Firestore active-chat doc (status: "pending")
  → Return SSE stream to browser

Local Cortex polls Firestore (every 1.5s)
  → Detects status: "pending"
  → Sets status: "processing"
  → Runs Agent SDK query with message + tool definitions
  → Agent SDK calls tools locally (direct execution)
  → Cortex writes response.content + response.parts progressively (~500ms)
  → Sets status: "streaming"

Web API onSnapshot fires on each Firestore update
  → Sends SSE delta event to browser
  → Browser renders text + tool call cards

Cortex finishes
  → Sets response.complete: true, status: "complete"
  → Web API sends SSE complete event, closes stream
```

### Autonomous Investigation
```
Service detects process crash
  → Writes event to ipc/cortex_events/{id}.json

Local Cortex detects event in main loop
  → Runs Agent SDK with autonomous prompt + event context
  → Tools execute locally (check logs, system info, restart process)
  → Writes results to Firestore cortex-events collection
  → If unresolved: writes escalation flag → web picks up → sends email
```

## Edge Cases & Considerations

- **Cortex offline**: Web API checks `cortexStatus.lastHeartbeat`. If stale (>30s), returns 503 to browser with "Cortex is not running" error
- **Multiple rapid messages**: Cortex processes one at a time. If a new message arrives while processing, it queues (pendingMessage is overwritten — web UI should prevent sending during active response)
- **API key not provisioned**: Cortex checks for key on startup. If missing, logs error, writes status to Firestore, doesn't poll for messages
- **Agent SDK pip conflicts**: Test early in Phase 1. If conflicts with existing packages, consider venv within bundled Python
- **Firestore write costs**: Batched to ~500ms. Typical conversation: ~15-20 writes. Acceptable.
- **Long-running tool calls**: Agent SDK has built-in timeout. Cortex sets `max_turns=15`, `max_budget_usd=2.0` as safety limits
- **Service restart**: Cortex process gets killed by NSSM (AppKillProcessTree). On service restart, Cortex is relaunched via `_try_launch_cortex()`. PID file is cleaned up on next startup.

---
**Last Updated**: 2026-03-22
