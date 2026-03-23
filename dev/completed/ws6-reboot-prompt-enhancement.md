# Workstream 6: Remote Reboot Prompt Enhancement

**Priority:** 6 | **Effort:** Low | **Round:** 1 (folded into WS4) | **Branch:** `dev`

## Goal
When the agent exhausts relaunch attempts for a process, instead of only showing a local GUI prompt, also write a `reboot_pending` flag to Firestore so the dashboard can show the situation and let admins approve or dismiss the reboot remotely.

## Status — COMPLETED (folded into WS4)
- [x] Agent: Write `reboot_pending` flag when relaunch limit hit
- [x] Agent: Listen for dashboard approval/dismissal (`dismiss_reboot_pending` command)
- [x] Web UI: "Reboot pending" banner on machine card (amber, AlertTriangle icon)
- [x] Web UI: Approve/Dismiss buttons (admin-only)
- [ ] Testing: Relaunch limit → dashboard shows pending
- [ ] Testing: Approve from dashboard → reboot executes
- [ ] Testing: Dismiss from dashboard → clears flag, resets counters

**Implementation details:** See `dev/active/ws4-remote-reboot-shutdown.md` for full implementation notes.

## Context

### What Already Exists
- **Relaunch tracking:** `owlette_service.py` tracks `relaunch_attempts` per process in memory. When the limit is hit, it shows a GUI prompt (30-second countdown).
- **GUI reboot prompt:** The GUI shows a dialog with a countdown. User can choose to reboot or cancel.
- **Remote reboot command:** After Workstream 4 is complete, `reboot_machine` and `cancel_reboot` commands will exist.
- **Firestore flags:** After Workstream 4, `rebooting` and `shuttingDown` flags will exist on machine documents.

### Dependency
**Depends on Workstream 4 (Remote Reboot/Shutdown).** The reboot command infrastructure must exist before this enhancement. Can be developed in parallel if the agent-side reboot command is stubbed.

### Files to Modify
| File | Change |
|------|--------|
| `agent/src/owlette_service.py` | When relaunch limit hit, write `reboot_pending` to Firestore + include process name and reason |
| `agent/src/firebase_client.py` | Add `set_reboot_pending(process_name, reason)` and `clear_reboot_pending()` methods |
| `web/components/MachineCard.tsx` | Show "Reboot pending" banner with Approve/Dismiss buttons |

### Implementation Details

**Agent — When relaunch limit is hit (`owlette_service.py`):**
```python
# Current behavior: show GUI prompt
# New behavior: ALSO write to Firestore

def _on_relaunch_limit_exceeded(self, process_name, max_attempts):
    """Called when a process has exhausted its relaunch attempts."""

    # Write to Firestore so dashboard can see it
    self.firebase_client.set_reboot_pending(
        process_name=process_name,
        reason=f'{process_name} crashed {max_attempts} times',
        timestamp=time.time()
    )

    # Still show local GUI prompt as fallback
    self._show_reboot_prompt(process_name, max_attempts)
```

**Firestore document update:**
```
sites/{siteId}/machines/{machineId}/presence:
  rebootPending: {
    active: true,
    processName: "MyApp.exe",
    reason: "MyApp.exe crashed 3 times",
    timestamp: 1234567890
  }
```

**Agent — Listen for dashboard response:**
The agent already listens for commands. Dashboard approval sends a `reboot_machine` command (from WS4). Dashboard dismissal sends a new `dismiss_reboot_pending` command that:
- Clears the `reboot_pending` flag
- Resets relaunch counters for the failed process
- Cancels the local GUI prompt if still showing
- Logs event: "Reboot dismissed by admin from dashboard"

**Web UI — Machine Card banner:**
When `rebootPending.active === true` on the machine document:
- Show a warning banner at the top of the machine card:
  - "Reboot pending: [processName] crashed [N] times"
  - **Approve** button → sends `reboot_machine` command (from WS4)
  - **Dismiss** button → sends `dismiss_reboot_pending` command
- Banner color: amber/warning
- If no dashboard response within 5 minutes, agent proceeds with local prompt behavior (existing fallback)

### Key Considerations
- **This enhances, not replaces, the local GUI prompt.** The local prompt is the fallback if no one is watching the dashboard.
- **Keep the 5-minute timeout.** If no dashboard response, the local behavior takes over. Don't leave machines in a broken state indefinitely.
- **Clearing `reboot_pending`:** Must be cleared on: reboot approved, dismissal, agent restart, or timeout.
- **The dismiss action should reset relaunch counters** for the affected process, giving it a fresh start.

### Testing Plan
1. Set a process with `relaunch_attempts: 1` → kill it twice → verify "Reboot pending" appears in dashboard
2. Click "Approve" → verify reboot executes (via WS4's reboot command)
3. Click "Dismiss" → verify flag clears, counters reset, process gets fresh relaunch attempts
4. Ignore dashboard for 5 minutes → verify local GUI prompt still appears as fallback
5. Restart agent while reboot_pending is active → verify flag is cleared on startup
