# Workstream 4: Remote Reboot/Shutdown

**Priority:** 4 | **Effort:** Low | **Round:** 1 (parallel with WS1) | **Branch:** `dev`

## Goal
Add explicit reboot and shutdown commands triggered from the dashboard with confirmation dialogs. Includes cancel capability.

## Status
- [x] Agent: `reboot_machine` command handler
- [x] Agent: `shutdown_machine` command handler
- [x] Agent: `cancel_reboot` command handler
- [x] Agent: `dismiss_reboot_pending` command handler (WS6)
- [x] Agent: Write `rebooting`/`shuttingDown` flags to Firestore
- [x] Agent: Write `rebootPending` when relaunch limit exceeded (WS6)
- [x] Agent: Startup cleanup of stale flags
- [x] Web UI: Reboot/Shutdown in MachineContextMenu (admin-only, online machines)
- [x] Web UI: Confirmation dialogs with 30s countdown warning
- [x] Web UI: "Rebooting..."/"Shutting down..." status badges (card + list view)
- [x] Web UI: Cancel button during countdown (card view)
- [x] Web UI: Reboot pending banner with Approve/Dismiss (card view, WS6)
- [x] Web: `sendMachineCommand` helper + 4 command functions in useFirestore
- [ ] Testing: Reboot from dashboard → machine reboots in 30s
- [ ] Testing: Cancel reboot before timeout
- [ ] Testing: Machine comes back online after reboot
- [ ] Testing: Admin-only permission check
- [ ] Testing: Reboot pending → approve from dashboard
- [ ] Testing: Reboot pending → dismiss resets counters
- [x] **Known issue:** `useMachines()` hook may not extract `rebooting`/`shuttingDown`/`rebootPending` fields from Firestore data — needs verification

## What Was Implemented

### Agent — `owlette_service.py`

**Command handlers (lines ~2410-2499):**
- `_handle_reboot_machine()` — Logs warning event, sets `rebooting: true` flag, runs `shutdown /r /t 30`
- `_handle_shutdown_machine()` — Logs warning event, sets `shuttingDown: true` flag, runs `shutdown /s /t 30`
- `_handle_cancel_reboot()` — Runs `shutdown /a`, clears both flags, logs info event. Fails gracefully if no pending shutdown.
- `_handle_dismiss_reboot_pending()` — Clears `rebootPending` flag, resets `relaunch_attempts` counter for the process, kills local prompt GUI, logs info event.

**Reboot pending trigger (lines ~1087-1133):**
When process exceeds relaunch limit (`reached_max_relaunch_attempts()`):
- Writes `rebootPending` to Firestore with `processName`, `reason`, `timestamp`
- Still launches local GUI prompt as fallback
- Resets relaunch counter after prompt launches

**Startup cleanup (lines ~2726-2728):**
- Clears `rebooting`, `shuttingDown` flags and `rebootPending` on service start

### Agent — `firebase_client.py`

- `set_machine_flag(flag_name, value)` — Sets arbitrary flag on machine document (lines ~993-1005)
- `set_reboot_pending(process_name, reason, timestamp)` — Writes `rebootPending` object (lines ~1007-1026)
- `clear_reboot_pending()` — Resets `rebootPending` to inactive (lines ~1028-1047)

### Web — `useFirestore.ts`

**Machine interface extensions:**
- Added `rebooting?: boolean`, `shuttingDown?: boolean`, `rebootPending?: { active, processName, reason, timestamp }`

**Command functions (lines ~738-769):**
- `sendMachineCommand(machineId, commandType, extraData)` — generic helper
- `rebootMachine(machineId)` → `reboot_machine` command
- `shutdownMachine(machineId)` → `shutdown_machine` command
- `cancelReboot(machineId)` → `cancel_reboot` command
- `dismissRebootPending(machineId, processName)` → `dismiss_reboot_pending` command

### Web — `MachineContextMenu.tsx`

- Reboot item (blue, RotateCcw icon) + Shutdown item (orange, Power icon)
- Visible only when `isAdmin && isOnline`
- Confirmation dialogs with 30s countdown warning text
- Toast notifications on command sent

### Web — `MachineCardView.tsx`

- Status badges: "rebooting..." / "shutting down..." (amber) when flags are set
- Cancel button (admin-only, visible during reboot/shutdown countdown)
- Reboot pending banner: amber warning with Approve (triggers reboot) and Dismiss (clears pending) buttons

### Web — `MachineListView.tsx`

- Status badges for rebooting/shutting down states
- Receives reboot/shutdown handlers via props (no interactive cancel UI in list view)

### Web — `page.tsx`

- Wires all 4 command functions from `useMachines()` hook to card and list views

### Firestore Data

**Machine document fields:**
```
sites/{siteId}/machines/{machineId}:
  rebooting: boolean
  shuttingDown: boolean
  rebootPending: { active: boolean, processName: string, reason: string, timestamp: number }
```

**Commands written to:**
```
sites/{siteId}/machines/{machineId}/commands/pending
```

### Known Issue
The `useMachines()` hook defines `rebooting`, `shuttingDown`, and `rebootPending` in the Machine interface but may not be extracting these fields from the Firestore document data in the data mapping (lines ~370-377). This could cause the UI to always show `undefined` for these fields. **Needs verification** — check if the machine data spread operator includes these fields or if they need explicit extraction.

### Testing Plan

**Using the Admin API:**
```bash
# Send reboot command
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"reboot_machine","wait":true}'

# Cancel reboot
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"cancel_reboot","wait":true}'

# Send shutdown command
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"shutdown_machine","wait":true}'

# Dismiss reboot pending
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"dismiss_reboot_pending","data":{"process_name":"MyApp.exe"},"wait":true}'
```

1. Trigger reboot from dashboard context menu → verify confirmation dialog → verify `shutdown /r /t 30` runs
2. Cancel reboot within 30 seconds → verify `shutdown /a` cancels
3. Let reboot complete → verify machine comes back online, flags cleared, processes relaunch
4. Log in as non-admin → verify reboot/shutdown items not visible in context menu
5. Set a process with `relaunch_attempts: 1` → kill twice → verify reboot pending banner appears
6. Click Approve on reboot pending → verify reboot executes
7. Click Dismiss on reboot pending → verify flag clears and process gets fresh attempts
