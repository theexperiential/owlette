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

### What Was Implemented

**Agent — `firebase_client.py`:**
- Added `send_process_alert(process_name, error_message, event_type)` method
- Spawns daemon thread that POSTs to `/api/agent/alert` with bearer token, `eventType`, `processName`, `errorMessage`, `agentVersion`
- Non-blocking, failures logged as warnings

**Agent — `owlette_service.py`:**
- Added `send_process_alert()` calls after all 3 crash/failure locations:
  1. `kill_and_relaunch_process()` exception handler (~line 1177)
  2. `handle_process_launch()` launch exception (~line 1225)
  3. `handle_process()` unexpected exit detection (~line 1408)

**Web API — `route.ts`:**
- Extended to accept `eventType` (default: `'connection_failure'` for backward compat) and `processName`
- Per-process rate limiting via `processAlertRateLimit` (3/hr per `machineId:processName` key in Upstash Redis)
- New `buildProcessAlertEmail()` template with Process, Event, Error, Machine, Agent Version, Time
- Recipients filtered via `getSiteProcessAlertEmails()` (users with `processAlerts !== false`)

**Web — `rateLimit.ts`:**
- Added `processAlertRateLimit` export (3 requests/hr, `process-alert` prefix)

**Web — `adminUtils.server.ts`:**
- Added `getSiteProcessAlertEmails(siteId)` — queries users by `processAlerts` preference

**Web — `AuthContext.tsx`:**
- Added `processAlerts: boolean` to `UserPreferences` interface (default: `true`)

**Web — `AccountSettingsDialog.tsx`:**
- Added "process crash alerts" toggle below "machine offline alerts" in Preferences section

### Rate Limiting Strategy
- Key: `process_alert:{machineId}:{processName}` (not IP-based — multiple processes on same machine need independent limits)
- Limit: 3 alerts per hour per process per machine
- This prevents crash-loop spam while still alerting on genuine crashes
- After rate limit hit, log a warning but don't send email

### Testing Plan

**Using the Admin API with API keys (see `dev/active/ws0-admin-api.md` for setup):**

Create an API key first via the dashboard or session cookie, then use the `x-api-key` header:

1. **Simulate a crash alert via API:**
   ```bash
   curl -X POST "http://localhost:3000/api/admin/events/simulate" \
     -H "x-api-key: owk_YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"siteId":"default_site","event":"process_crash","data":{"processName":"MyApp.exe","errorMessage":"Exited with code 1"}}'
   ```
   Verify email arrives. Check Resend dashboard for delivery confirmation.

2. **Test rate limiting:** Note: the simulate endpoint uses IP-based rate limiting (5/hr), not the per-process limiter. Per-process rate limiting (3/hr per `machineId:processName`) only applies to the real `/api/agent/alert` endpoint.

3. **Test preference toggle:** Toggle `processAlerts` off in Account Settings > Preferences, then simulate again → response should show `emailSent: false, reason: "No recipients"`.

4. **Test backward compat:**
   ```bash
   curl -X POST "http://localhost:3000/api/admin/events/simulate" \
     -H "x-api-key: owk_YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"siteId":"default_site","event":"connection_failure","data":{"errorMessage":"Simulated connection loss"}}'
   ```

5. **End-to-end with real agent:** Requires deploying to `dev.owlette.app` first (agent POSTs to its configured `api_base`). Kill a monitored process via Task Manager → verify email arrives within 30 seconds.

### Notes
- Do NOT block the 10-second monitoring loop. All alert sending must be in daemon threads.
- Do NOT merge `healthAlerts` and `processAlerts` into one toggle. Keep them separate.
- The agent may not have network access when a crash happens (if the crash is related to a network issue). The alert POST should fail silently — the cron health check will catch the machine going offline separately.
