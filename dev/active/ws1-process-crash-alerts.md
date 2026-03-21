# Workstream 1: Process Crash Email Alerts

**Priority:** 1 (highest) | **Effort:** Low | **Round:** 1 (parallel with WS4+6) | **Branch:** `dev`

## Goal
When a process crashes or fails to start, email site admins who have alerts enabled. Extend the existing `/api/agent/alert` endpoint and agent alert infrastructure.

## Status
- [x] Agent: Add process crash alert POST
- [x] Web API: Extend `/api/agent/alert` for process events
- [x] Web API: Process crash email template
- [x] Web API: Per-process rate limiting (3/hr per process+machine combo)
- [x] Web UI: Add `processAlerts` preference toggle
- [ ] Testing: Manual crash → email arrives
- [ ] Testing: Crash loop → rate limiting works
- [ ] Testing: Preference toggle → respects opt-out
- [ ] Testing: Backward compat (old agents without eventType)

## Parallel Safety (Round 1)
This workstream runs in parallel with WS4 (Remote Reboot/Shutdown). To avoid conflicts:

**Files ONLY this agent should touch:**
- `web/app/api/agent/alert/route.ts` (extend for process events)
- `web/components/AccountSettingsDialog.tsx` (add processAlerts toggle)
- `web/contexts/AuthContext.tsx` (preferences update if needed)

**Files SHARED with WS4 — coordinate carefully:**
- `agent/src/owlette_service.py` — WS1 adds alert POST calls after crash events. WS4 adds command handlers. These are different sections of the file and should not conflict, but avoid reorganizing shared code.
- `agent/src/firebase_client.py` — WS1 adds `send_process_alert()`. WS4 adds `set_machine_flag()`. Different methods, no conflict expected.

**Files this agent should NOT touch:**
- `web/components/MachineCard.tsx` (WS4 owns this for reboot buttons)
- Any command handler registration in `_process_command()` (WS4 owns this)

## Context

### What Already Exists
- **Agent health alerts:** `owlette_service.py` lines ~446-469 spawn a daemon thread to POST to `/api/agent/alert` on connection failures. Reuse this exact pattern.
- **Alert endpoint:** `web/app/api/agent/alert/route.ts` handles connection failure alerts, sends emails via Resend, rate-limited to 5/hr per IP.
- **Event logging:** `firebase_client.py` `log_event()` already logs `process_crash` and `process_start_failed` events to Firestore.
- **Alert recipients:** `getSiteAlertRecipients()` in the health-check route queries users with `healthAlerts !== false` for a given site.
- **Unsubscribe system:** HMAC-signed unsubscribe tokens already exist.
- **User preferences:** `AccountSettingsDialog.tsx` has a "Machine Offline Alerts" toggle writing to `users/{userId}/preferences/healthAlerts`.

### Files to Modify
| File | Change |
|------|--------|
| `agent/src/owlette_service.py` | After `log_event('process_crash', ...)` and `log_event('process_start_failed', ...)` calls, spawn daemon thread to POST alert |
| `agent/src/firebase_client.py` | Add `send_process_alert(site_id, machine_id, process_name, error_message, event_type)` method |
| `web/app/api/agent/alert/route.ts` | Accept `eventType` field, route to different email templates, separate rate limiting |
| `web/components/AccountSettingsDialog.tsx` | Add "Process Crash Alerts" toggle for `processAlerts` preference |
| `web/contexts/AuthContext.tsx` | Ensure `processAlerts` is included in preferences read/write |

### Implementation Details

**Agent side — `firebase_client.py`:**
```python
def send_process_alert(self, process_name, error_message, event_type='process_crash'):
    """Send process alert to web API. Non-blocking (fire and forget)."""
    def _send():
        try:
            payload = {
                'siteId': self.site_id,
                'machineId': self.machine_id,
                'eventType': event_type,
                'processName': process_name,
                'errorMessage': error_message or 'Process exited unexpectedly',
                'agentVersion': self.agent_version
            }
            # POST to /api/agent/alert with bearer token
            # Same auth pattern as existing health alert
        except Exception as e:
            logger.warning(f"Failed to send process alert: {e}")

    thread = threading.Thread(target=_send, daemon=True)
    thread.start()
```

**Agent side — `owlette_service.py`:**
Find all locations where `log_event('process_crash', ...)` and `log_event('process_start_failed', ...)` are called. After each, add:
```python
self.firebase_client.send_process_alert(process_name, error_details, 'process_crash')
```

**Web API — `route.ts`:**
- Add `eventType` to request body validation (default: `'connection_failure'` for backward compat)
- Add `processName` to request body
- New rate limit strategy: key by `${ip}:${eventType}:${processName}:${machineId}`, limit 3/hr
- New email template for process events:
  - Subject: `[Owlette] Process crashed: {processName} on {machineName}`
  - Body: HTML table with Machine, Process, Error, Timestamp, Agent Version
- Filter recipients: query users with `processAlerts !== false` (default true)

**User preference:**
- Add `processAlerts` boolean (default: `true`) to user preferences
- Separate from `healthAlerts` — users can opt into machine alerts but not process alerts
- Add toggle in `AccountSettingsDialog.tsx` below existing "Machine Offline Alerts"
- Label: "Process Crash Alerts"
- Description: "Receive email alerts when monitored processes crash or fail to start"

### Rate Limiting Strategy
- Key: `process_alert:{machineId}:{processName}` (not IP-based — multiple processes on same machine need independent limits)
- Limit: 3 alerts per hour per process per machine
- This prevents crash-loop spam while still alerting on genuine crashes
- After rate limit hit, log a warning but don't send email

### Testing Plan
1. Configure a process in Owlette, start it, then kill it via Task Manager → verify email arrives within 30 seconds
2. Create a process that exits immediately (e.g., `cmd /c exit 1`) with autolaunch on → verify only 3 emails arrive in the first hour
3. Toggle `processAlerts` off in account settings → kill a process → verify no email
4. Test with an agent that doesn't send `eventType` field → verify existing connection_failure behavior still works
5. Check email template renders correctly (machine name, process name, timestamp)

### Notes
- Do NOT block the 10-second monitoring loop. All alert sending must be in daemon threads.
- Do NOT merge `healthAlerts` and `processAlerts` into one toggle. Keep them separate.
- The agent may not have network access when a crash happens (if the crash is related to a network issue). The alert POST should fail silently — the cron health check will catch the machine going offline separately.
