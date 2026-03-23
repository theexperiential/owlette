# Owlette v2.2.0 — Alerting, Controls & Scheduling

## Execution Plan

All work happens on the `dev` branch. Commit and verify each round before starting the next.

| Round | Workstreams | Agent(s) | Status |
|-------|------------|----------|--------|
| **0** | WS0 (Admin API + API Keys) | 1 agent | **DONE** |
| **1** | WS1 (Crash Alerts) + WS4+6 (Reboot/Shutdown + Prompt) | 2 agents in parallel | **DONE** |
| **2** | WS2 (Webhooks) | 1 agent | **DONE** |
| **3** | WS3 (Screenshots) | 1 agent | **DONE** |
| **4** | WS5 (Scheduling) | 1 agent | NOT STARTED |
| **5** | Cortex: Local Agent SDK + Autonomous Mode | 1 agent | **NOT STARTED** |

## How to Assign Each Round

### Round 0 — Admin API (prerequisite)

One agent. This creates the API routes that all other workstreams use for testing.

```
Read dev/active/ws0-admin-api.md and implement everything in it.
This creates new API routes only — do not modify any existing files.
Work on the dev branch. Commit when done with a conventional commit message.
```

After it finishes: verify the endpoints work with the curl examples in the doc, then proceed.

### Round 1 — Two agents in parallel

Open two Claude Code sessions (or use VS Code split terminals). Give each agent its task:

**Agent A — Crash Alerts:**
```
Read dev/active/ws1-process-crash-alerts.md and implement everything in it.
Follow the parallel safety rules — only touch the files listed as yours.
Work on the dev branch. Commit when done with a conventional commit message.
After implementation, test using the Admin API endpoints (see dev/active/ws0-admin-api.md
for curl examples). Use /api/admin/events/simulate to trigger a process_crash event
and verify the email is sent.
```

**Agent B — Reboot/Shutdown:**
```
Read dev/active/ws4-remote-reboot-shutdown.md and implement everything in it,
including the WS6 enhancement described in dev/active/ws6-reboot-prompt-enhancement.md.
Follow the parallel safety rules — only touch the files listed as yours.
Work on the dev branch. Commit when done with a conventional commit message.
After implementation, test using the Admin API endpoints (see dev/active/ws0-admin-api.md
for curl examples). Use /api/admin/commands/send to send reboot_machine and
shutdown_machine commands.
```

After both finish: review, test, resolve any issues, then move their docs to `dev/completed/`.

### Round 2 — One agent

```
Read dev/active/ws2-webhook-notifications.md and implement everything in it.
Note the prerequisites section — read the current state of files modified by
Round 1 (especially web/app/api/agent/alert/route.ts) before starting.
Work on the dev branch. Commit when done with a conventional commit message.
After implementation, test using /api/admin/events/simulate to trigger events
and verify webhooks fire to a test URL.
```

### Round 3 — One agent

```
Read dev/active/ws3-screenshot-capture.md and implement everything in it.
Work on the dev branch. Commit when done with a conventional commit message.
After implementation, test using /api/admin/commands/send to send a
capture_screenshot command and verify the screenshot is returned.
```

### Round 5 — Cortex: Local Agent SDK + Autonomous Mode

```
Read dev/active/local-cortex-agent-sdk/cortex-plan.md for the full architecture,
then use dev/active/local-cortex-agent-sdk/cortex-tasks.md as your checklist.
Reference dev/active/local-cortex-agent-sdk/cortex-context.md for integration points.
This is a multi-phase feature — work through phases 0-7 sequentially.
Work on the dev branch. Commit after each phase with a conventional commit message.
```

### Round 4 — One agent

```
Read dev/active/ws5-process-scheduling.md and implement everything in it.
This touches the core agent monitoring loop — read the current state of
owlette_service.py carefully before making changes, as previous rounds
may have modified it.
Work on the dev branch. Commit when done with a conventional commit message.
After implementation, test using /api/admin/machines/status to verify
schedule fields appear in machine/process status responses.
```

## File Ownership (Round 1 Only)

Round 1 runs two agents in parallel. File ownership prevents conflicts:

| File | Owner | Other agent |
|------|-------|-------------|
| `web/app/api/agent/alert/route.ts` | WS1 | WS4: don't touch |
| `web/components/AccountSettingsDialog.tsx` | WS1 | WS4: don't touch |
| `web/components/MachineCard.tsx` | WS4 | WS1: don't touch |
| `agent/src/owlette_service.py` | Shared | WS1: crash alert calls only. WS4: command handlers + relaunch path only |
| `agent/src/firebase_client.py` | Shared | WS1: `send_process_alert()`. WS4: `set_machine_flag()`, `set_reboot_pending()` |

Rounds 2–4 are sequential — no ownership issues.

## After All Rounds

- Version bump: `node scripts/sync-versions.js 2.2.0`
- Run `/build-and-fix` to verify everything compiles
- Move all docs from `dev/active/` to `dev/completed/`
- Test end-to-end on a live machine
- PR from `dev` to `main` when ready for production
